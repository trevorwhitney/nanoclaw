import { AgentMailClient } from 'agentmail';
import { ProxyAgent } from 'undici';
import fs from 'fs';

import { ASSISTANT_NAME, ONECLI_URL } from '../config.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';
import { OneCLI } from '@onecli-sh/sdk';
import { readEnvFile } from '../env.js';

export interface AgentMailChannelOpts {
  onMessage: ChannelOpts['onMessage'];
  onChatMetadata: ChannelOpts['onChatMetadata'];
  registeredGroups: ChannelOpts['registeredGroups'];
}

export class AgentMailChannel implements Channel {
  name = 'agentmail';

  private client: AgentMailClient;
  private opts: AgentMailChannelOpts;
  private configuredInboxEmail: string | undefined;
  private inboxId: string | null = null;
  private inboxEmail: string | null = null;
  private pollingInterval: NodeJS.Timeout | null = null;
  private processedMessageIds = new Set<string>();
  private pageToken: string | undefined;

  constructor(
    client: AgentMailClient,
    opts: AgentMailChannelOpts,
    configuredInboxEmail?: string,
  ) {
    this.client = client;
    this.opts = opts;
    this.configuredInboxEmail = configuredInboxEmail;
  }

  async connect(): Promise<void> {
    try {
      let inbox;
      if (this.configuredInboxEmail) {
        // Use the specific inbox by email address (email is the inbox ID)
        try {
          inbox = await this.client.inboxes.get(this.configuredInboxEmail);
          logger.info(
            { email: this.configuredInboxEmail },
            'Using configured AgentMail inbox',
          );
        } catch (error) {
          logger.warn(
            { email: this.configuredInboxEmail, error: String(error) },
            'Configured inbox not found, creating new one',
          );
          inbox = await this.client.inboxes.create({
            clientId: `nanoclaw-${ASSISTANT_NAME.toLowerCase().replace(/\s+/g, '-')}`,
            displayName: ASSISTANT_NAME,
          });
        }
      } else {
        // Create or retrieve inbox with idempotent clientId
        inbox = await this.client.inboxes.create({
          clientId: `nanoclaw-${ASSISTANT_NAME.toLowerCase().replace(/\s+/g, '-')}`,
          displayName: ASSISTANT_NAME,
        });
      }

      this.inboxId = inbox.inboxId;
      this.inboxEmail = inbox.email;

      logger.info(
        { inboxId: this.inboxId, email: this.inboxEmail },
        'AgentMail inbox connected',
      );

      console.log(`\n  AgentMail inbox: ${this.inboxEmail}`);
      console.log(
        `  Inbox ID (for registration): am:${this.inboxId}`,
      );
      console.log(
        `  Send emails to ${this.inboxEmail} to interact with ${ASSISTANT_NAME}\n`,
      );

      // Start polling for new messages every 10 seconds
      this.startPolling();
    } catch (error: unknown) {
      const msg =
        (error as { body?: { message?: string } })?.body?.message ??
        String(error);
      logger.error({ error: msg }, 'Failed to connect AgentMail');
      throw new Error(`AgentMail connection failed: ${msg}`);
    }
  }

  private startPolling(): void {
    // Poll every 10 seconds
    this.pollingInterval = setInterval(
      () => this.pollMessages(),
      10000,
    );

    // Do an immediate poll on connect
    void this.pollMessages();
  }

  private async pollMessages(): Promise<void> {
    if (!this.inboxId) return;

    try {
      const response = await this.client.inboxes.messages.list(
        this.inboxId,
        {
          limit: 20,
          pageToken: this.pageToken,
        },
      );

      // Process messages in reverse order (oldest first)
      const messages = [...response.messages].reverse();

      for (const msgItem of messages) {
        // Skip if already processed
        if (this.processedMessageIds.has(msgItem.messageId)) continue;

        // Mark as processed
        this.processedMessageIds.add(msgItem.messageId);

        // Cleanup old processed IDs (keep last 1000)
        if (this.processedMessageIds.size > 1000) {
          const toDelete = Array.from(this.processedMessageIds).slice(0, 100);
          toDelete.forEach((id) => this.processedMessageIds.delete(id));
        }

        // Create JID for this inbox
        const chatJid = `am:${this.inboxId}`;

        // Parse sender email from "Display Name <email@domain.com>" or "email@domain.com" format
        const fromStr = msgItem.from;
        const emailMatch = fromStr.match(/<(.+?)>/);
        const senderEmail = emailMatch ? emailMatch[1] : fromStr;
        const senderName = emailMatch
          ? fromStr.substring(0, fromStr.indexOf('<')).trim()
          : senderEmail;

        const timestamp = new Date(msgItem.timestamp).toISOString();

        // Store chat metadata - AgentMail is always 1:1, not a group
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          this.inboxEmail || chatJid,
          'agentmail',
          false, // not a group
        );

        // Check if this inbox is registered
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) {
          logger.debug(
            { chatJid, from: senderEmail },
            'Message from unregistered AgentMail inbox',
          );
          continue;
        }

        // Fetch full message content
        const fullMsg = await this.client.inboxes.messages.get(
          this.inboxId,
          msgItem.messageId,
        );

        // Use extracted text/html if available, otherwise fall back to raw
        const content =
          fullMsg.extractedText ||
          fullMsg.extractedHtml ||
          fullMsg.text ||
          fullMsg.html ||
          fullMsg.preview ||
          '';

        // Build full content with subject
        const fullContent = fullMsg.subject
          ? `Subject: ${fullMsg.subject}\n\n${content}`
          : content;

        // Deliver message to orchestrator
        this.opts.onMessage(chatJid, {
          id: msgItem.messageId,
          chat_jid: chatJid,
          sender: senderEmail,
          sender_name: senderName,
          content: fullContent,
          timestamp,
          is_from_me: false,
        });

        logger.info(
          { chatJid, from: senderEmail, subject: fullMsg.subject },
          'AgentMail message stored',
        );
      }

      // Update page token for next poll
      this.pageToken = response.nextPageToken;
    } catch (error: unknown) {
      const msg =
        (error as { body?: { message?: string } })?.body?.message ??
        String(error);
      logger.error({ error: msg }, 'Failed to poll AgentMail messages');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.inboxId) {
      logger.warn('AgentMail inbox not initialized');
      return;
    }

    try {
      // Extract the inbox ID from the JID
      const inboxId = jid.replace(/^am:/, '');

      // Get the most recent message to determine recipient
      const response = await this.client.inboxes.messages.list(inboxId, {
        limit: 1,
      });

      if (response.messages.length === 0) {
        logger.warn({ jid }, 'No messages found to determine recipient');
        return;
      }

      const lastMessage = response.messages[0];

      // Parse sender email from "Display Name <email@domain.com>" or "email@domain.com" format
      const fromStr = lastMessage.from;
      const emailMatch = fromStr.match(/<(.+?)>/);
      const recipientEmail = emailMatch ? emailMatch[1] : fromStr;

      // Send reply
      await this.client.inboxes.messages.send(inboxId, {
        to: recipientEmail,
        subject: `Re: ${lastMessage.subject || '(no subject)'}`,
        text,
      });

      logger.info(
        { jid, to: recipientEmail, length: text.length },
        'AgentMail message sent',
      );
    } catch (error: unknown) {
      const msg =
        (error as { body?: { message?: string } })?.body?.message ??
        String(error);
      logger.error({ jid, error: msg }, 'Failed to send AgentMail message');
    }
  }

  isConnected(): boolean {
    return this.inboxId !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('am:');
  }

  async disconnect(): Promise<void> {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }
    this.inboxId = null;
    this.inboxEmail = null;
    logger.info('AgentMail channel stopped');
  }
}

registerChannel('agentmail', async (opts: ChannelOpts) => {
  const onecli = new OneCLI({ url: ONECLI_URL });

  // Read configured inbox email from .env
  const envVars = readEnvFile(['AGENTMAIL_INBOX_EMAIL']);
  const configuredInboxEmail = envVars.AGENTMAIL_INBOX_EMAIL;

  try {
    // Get OneCLI proxy configuration (no agent ID needed for host process)
    const config = await onecli.getContainerConfig();

    // Extract proxy URL from env vars and fix host for host process
    let proxyUrl = config.env.HTTPS_PROXY || config.env.HTTP_PROXY;

    // Replace host.docker.internal with localhost for host process
    if (proxyUrl) {
      proxyUrl = proxyUrl.replace('host.docker.internal', 'localhost');
    }

    if (!proxyUrl) {
      logger.warn('AgentMail: OneCLI proxy not configured');
      return null;
    }

    // Configure CA certificate for SSL verification
    if (config.caCertificate) {
      // Save CA cert to temp location for this process
      const caCertPath = '/tmp/onecli-agentmail-ca.pem';
      fs.writeFileSync(caCertPath, config.caCertificate);

      // Set Node's CA bundle to include OneCLI CA
      if (!process.env.NODE_EXTRA_CA_CERTS) {
        process.env.NODE_EXTRA_CA_CERTS = caCertPath;
      }
    }

    // Set proxy environment variables for undici/fetch
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.HTTP_PROXY = proxyUrl;

    // Create proxy agent with proper configuration
    const proxyAgent = new ProxyAgent({
      uri: proxyUrl,
      // Don't verify proxy cert since OneCLI uses self-signed
      requestTls: {
        rejectUnauthorized: false,
      },
    });

    // Create custom fetch that uses the proxy
    const customFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      return fetch(input, {
        ...init,
        // @ts-expect-error - undici dispatcher type mismatch
        dispatcher: proxyAgent,
      });
    };

    logger.info(
      { proxyUrl: proxyUrl.replace(/:[^:@]+@/, ':***@') },
      'AgentMail configured to use OneCLI proxy',
    );

    // Create AgentMail client with proxy-enabled fetch and placeholder API key
    // The real API key will be injected by OneCLI proxy
    const client = new AgentMailClient({
      apiKey: 'placeholder',
      fetch: customFetch,
    });

    return new AgentMailChannel(client, opts, configuredInboxEmail);
  } catch (error) {
    logger.warn(
      { error: String(error) },
      'Failed to configure OneCLI proxy for AgentMail - channel disabled',
    );
    return null;
  }
});
