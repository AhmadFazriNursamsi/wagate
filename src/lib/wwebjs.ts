import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import qrcode from "qrcode-terminal";
import { Client, LocalAuth, MessageMedia } from "whatsapp-web.js";
import { env } from "../../env";
import {
  WHATSAPP_WEB_BUILD_VERSION,
  WHATSAPP_WEB_VERSION,
} from "../helper/constant";
import logger from "../helper/logger";
import { Helper } from "../helper/util";

export class WagateClient {
  client: Client;
  public qrCode: string | null = null;
  public phoneNumber: string = "";

  constructor(
    public readonly clientId: string,
    public partnerNumber: string = "",
    private helper = new Helper(),
  ) {
    this.client = new Client({
      authStrategy: new LocalAuth({ clientId }),
      webVersion: WHATSAPP_WEB_BUILD_VERSION,
      webVersionCache: { type: "none" },
      puppeteer: {
        ...(process.env.PUPPETEER_EXECUTABLE_PATH
          ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
          : {}),
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--no-zygote",
          "--disable-gpu",
          "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        ],
      },
    });

    this.client.on("qr", (qr) => this.onQR(qr));
    this.client.on("ready", () => this.onReady());
    this.client.on("authenticated", () => {
      this.qrCode = null;
      logger.info(`[${this.clientId}] ✅ Authenticated successfully`);
    });
    this.client.on("auth_failure", (msg) => {
      logger.error(`[${this.clientId}] ❌ Auth failure: ${msg}`);
    });
    this.client.on("disconnected", (reason) => {
      logger.warn(`[${this.clientId}] ⚠️ Disconnected: ${reason}`);
    });
  }

  private onQR(qr: string) {
    this.qrCode = qr;
    logger.info(`[${this.clientId}] Scan this QR code:`);
    qrcode.generate(qr, { small: true });
  }

  private async onReady() {
    this.qrCode = null;
    if (this.client.info?.wid?.user) {
      this.phoneNumber = this.client.info.wid.user;
    }
    logger.info(`[${this.clientId}] ✅ WHATSAPP BOT IS RUNNING (${this.phoneNumber || "unknown"})`);
    logger.info(`[${this.clientId}] WWJS: ${WHATSAPP_WEB_VERSION}`);
    logger.info(
      `[${this.clientId}] Web version: ${WHATSAPP_WEB_BUILD_VERSION}`,
    );
  }

  private async clearChromiumLocks() {
    const sessionDir = path.resolve(
      ".wwebjs_auth",
      `session-${this.clientId}`,
    );
    if (!existsSync(sessionDir)) return;
    for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      await rm(path.join(sessionDir, name), { force: true }).catch(() => {});
    }
  }

  async init() {
    await this.clearChromiumLocks();
    logger.info(`[${this.clientId}] Initializing — waiting for QR scan...`);

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`[${this.clientId}] Initialization timed out (5 min)`));
      }, 5 * 60 * 1000);

      this.client.on("ready", () => {
        clearTimeout(timeout);
        this.setupProfile();
        resolve();
      });

      this.client.on("auth_failure", (msg) => {
        clearTimeout(timeout);
        reject(new Error(`[${this.clientId}] Auth failed: ${msg}`));
      });

      this.client.initialize().catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  setupProfile() {
    if (env.NODE_ENV === "production") {
      const media = MessageMedia.fromFilePath("./logo.jpg");
      this.client.setProfilePicture(media);
      this.client.setDisplayName(
        (this.clientId === "client-1"
          ? env.DISPLAY_NAME_1
          : env.DISPLAY_NAME_2) || "",
      );
    }
  }

  async saveContact(number: string) {
    try {
      const contactId = `${number}@c.us`;
      try {
        await (this.client as any).saveOrEditAddressbookContact(contactId, `Partner ${number}`, "");
      } catch {
        // ignore if addressbook save isn't supported
      }
      // Pre-warm LID cache by forcing chat creation in WhatsApp Web internal store
      // This ensures addAndSendMsgToChat can resolve LID when we send messages later
      await (this.client as any).pupPage.evaluate(async (targetId: string) => {
        try {
          // enforceLidAndPnRetrieval fetches LID from WhatsApp servers via QueryExist
          await (window as any).WWebJS.enforceLidAndPnRetrieval(targetId);
          // findOrCreateLatestChat ensures the chat model exists in memory
          await (window as any).WWebJS.getChat(targetId, { getAsModel: false });
        } catch (e) {
          // non-fatal
        }
      }, contactId);
      const contact = await this.client.getContactById(contactId);
      if (contact) {
        logger.info(
          `[${this.clientId}] Partner contact ${number} is reachable`,
        );
      }
    } catch (err) {
      logger.warn(
        `[${this.clientId}] Could not verify partner contact ${number}`,
      );
    }
  }

  /**
   * Simulate typing indicator for 1-3 seconds before sending.
   */
  private async sendTyping(chatId: string) {
    try {
      const chat = await this.client.getChatById(chatId);
      await chat.sendStateTyping();
      const typingDuration = 1000 + Math.random() * 2000; // 1-3s
      await new Promise((r) => setTimeout(r, typingDuration));
      await chat.clearState();
    } catch (err) {
      logger.debug(`[${this.clientId}] Could not send typing state`);
    }
  }

  /**
   * Mark a chat as read (sendSeen) with a 1s delay.
   */
  async markAsRead(number: string) {
    try {
      await new Promise((r) => setTimeout(r, 1000));
      const chatId = await this.getJid(number);
      const chat = await this.client.getChatById(chatId);
      await chat.sendSeen();
      logger.debug(`[${this.clientId}] 👁️ Marked chat ${number} as read`);
    } catch (err) {
      logger.debug(`[${this.clientId}] Could not mark chat as read`);
    }
  }

  private async getJid(number: string): Promise<string> {
    const cleaned = number.replace(/\D/g, "");
    try {
      const numberId = await this.client.getNumberId(cleaned);
      if (numberId) {
        return numberId._serialized;
      }
    } catch (e) {
      // fallback
    }
    return `${cleaned}@c.us`;
  }

  async sendMsg(msg: string, to: string) {
    await this.helper.delay();
    const chatId = await this.getJid(to);
    await this.sendTyping(chatId);
    logger.info(`[${this.clientId}] 📤 Sending text to ${to} (${chatId})`);
    try {
      await this.client.sendMessage(chatId, msg);
    } catch (err: any) {
      if (err?.message?.includes("No LID")) {
        logger.warn(`[${this.clientId}] LID missing for ${chatId}, resolving LID address via getContactLidAndPhone...`);
        const cleaned = to.replace(/\D/g, "");
        const lidResults = await (this.client as any).getContactLidAndPhone(cleaned);
        const lidId = lidResults?.[0]?.lid;
        if (lidId) {
          logger.info(`[${this.clientId}] Sending via LID address: ${lidId}`);
          await this.client.sendMessage(lidId, msg);
        } else {
          logger.warn(`[${this.clientId}] No LID returned for ${chatId}, falling back to @c.us`);
          throw err;
        }
      } else {
        throw err;
      }
    }
  }

  async sendFile(msg: string = "", to: string, filePath: string) {
    await this.helper.delay();
    const chatId = await this.getJid(to);
    await this.sendTyping(chatId);
    logger.info(`[${this.clientId}] 📤 Sending media to ${to} (${chatId})`);
    const messageMedia = MessageMedia.fromFilePath(filePath);
    await this.client.sendMessage(chatId, messageMedia, {
      caption: msg,
    });
  }

  /**
   * Clear all messages in a chat with the given number.
   */
  async clearChat(number: string) {
    try {
      const chatId = `${number}@c.us`;
      const chat = await this.client.getChatById(chatId);
      await chat.clearMessages();
      logger.info(`[${this.clientId}] 🧹 Cleared chat with ${number}`);
    } catch (err) {
      logger.warn(
        `[${this.clientId}] Could not clear chat with ${number}`,
      );
    }
  }
}
