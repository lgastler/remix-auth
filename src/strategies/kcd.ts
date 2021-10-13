import crypto from "crypto";
import { redirect, SessionStorage } from "remix";
import { Strategy, StrategyOptions } from "../authenticator";

export interface KCDSendEmailOptions<User> {
  emailAddress: string;
  magicLink: string;
  user?: User | null;
  domainUrl: string;
}

export interface KCDSendEmailFunction<User> {
  (options: KCDSendEmailOptions<User>): Promise<void>;
}

export interface ValidateEmailFunction {
  (email: string): Promise<void>;
}

export interface KCDMagicLinkPayload {
  emailAddress: string;
  creationDate: string;
  validateSessionMagicLink: boolean;
}

export interface KCDStrategyOptions<User> {
  /**
   * The endpoint the user will go after clicking on the email link.
   */
  callbackURL: string;
  /**
   * A function to send the email. This function should receive the email
   * address of the user and the URL to redirect to and should return a Promise.
   * The value of the Promise will be ignored.
   */
  sendEmail: KCDSendEmailFunction<User>;
  /**
   * A function to validate the email address. This function should receive the
   * email address as a string and return a Promise. The value of the Promise
   * will be ignored, in case of error throw an error.
   *
   * By default it only test the email agains the RegExp `/.+@.+/`.
   */
  validateEmail?: ValidateEmailFunction;
  /**
   * A secret string used to encrypt the token.
   */
  secret: string;
  /**
   * The name of the form input used to get the email
   * @default "email"
   */
  emailField?: string;
  magicLinkSearchParam?: string;
  linkExpirationTime?: number;
  sessionErrorKey?: string;
  sessionMagicLinkKey?: string;
}

export interface KCDStrategyVerifyCallback<User> {
  (emailAddress: string): Promise<User>;
}

let validateEmail: ValidateEmailFunction = async (email) => {
  if (!/.+@.+/.test(email)) throw new Error("A valid email is required.");
};

export class KCDStrategy<User> implements Strategy<User> {
  name = "kcd";

  private verify: KCDStrategyVerifyCallback<User>;
  private emailField = "email";
  private callbackURL: string;
  private sendEmail: KCDSendEmailFunction<User>;
  private validateEmail: ValidateEmailFunction;
  private secret: string;
  private algorithm = "aes-256-ctr";
  private ivLength = 16;
  private encryptionKey: Buffer;
  private magicLinkSearchParam: string;
  private linkExpirationTime: number;
  private sessionErrorKey: string;
  private sessionMagicLinkKey: string;

  constructor(
    options: KCDStrategyOptions<User>,
    verify: KCDStrategyVerifyCallback<User>
  ) {
    this.verify = verify;
    this.sendEmail = options.sendEmail;
    this.callbackURL = options.callbackURL;
    this.secret = options.secret;
    this.sessionErrorKey = options.sessionErrorKey ?? "kcd:error";
    this.sessionMagicLinkKey = options.sessionMagicLinkKey ?? "kcd:magiclink";
    this.validateEmail = options.validateEmail ?? validateEmail;
    this.emailField = options.emailField ?? this.emailField;
    this.magicLinkSearchParam = options.magicLinkSearchParam ?? "magic";
    this.linkExpirationTime = options.linkExpirationTime ?? 1000 * 60 * 30; // 30 minutes
    this.encryptionKey = crypto.scryptSync(this.secret, "salt", 32);
  }

  async authenticate(
    request: Request,
    sessionStorage: SessionStorage,
    options: StrategyOptions
  ): Promise<User> {
    let session = await sessionStorage.getSession(
      request.headers.get("Cookie")
    );

    // This should only be called in an action if it's used to start the login
    // process
    if (request.method === "POST") {
      if (!options.successRedirect) {
        throw new Error("Missing successRedirect. The successRedirect");
      }

      // get the email address from the request body
      let body = new URLSearchParams(await request.text());
      let emailAddress = body.get(this.emailField);

      // if it doesn't have an email address,
      if (!emailAddress) {
        if (!options.failureRedirect) throw new Error("Missing email address.");
        session.flash(this.sessionErrorKey, "Missing email address.");
        let cookie = await sessionStorage.commitSession(session);
        throw redirect(options.failureRedirect, {
          headers: { "Set-Cookie": cookie },
        });
      }

      // Validate the email address
      try {
        await this.validateEmail(emailAddress);
      } catch (error) {
        if (!options.failureRedirect) throw error;
        let message = (error as Error).message;
        session.flash(this.sessionErrorKey, message);
        let cookie = await sessionStorage.commitSession(session);
        throw redirect(options.failureRedirect, {
          headers: { "Set-Cookie": cookie },
        });
      }

      try {
        let domainUrl = this.getDomainURL(request);
        let magicLink = await this.sendToken(emailAddress, domainUrl);

        session.set(this.sessionMagicLinkKey, magicLink);
        throw redirect(options.successRedirect, {
          headers: {
            "Set-Cookie": await sessionStorage.commitSession(session),
          },
        });
      } catch (error) {
        if (!options.failureRedirect) throw error;
        let message = (error as Error).message;
        session.flash(this.sessionErrorKey, message);
        let cookie = await sessionStorage.commitSession(session);
        throw redirect(options.failureRedirect, {
          headers: { "Set-Cookie": cookie },
        });
      }

      // If we get here, the user clicked on the magic link inside email
      let email = this.validateMagicLink(
        request.url,
        session.get(this.sessionMagicLinkKey) as string | undefined
      );
    }
  }

  private getDomainURL(request: Request): string {
    let host =
      request.headers.get("X-Forwarded-Host") ?? request.headers.get("host");

    if (!host) {
      throw new Error("Could not determine domain URL.");
    }

    let protocol = host.includes("localhost") ? "http" : "https";
    return `${protocol}://${host}`;
  }

  private getMagicLink(emailAddress: string, domainUrl: string) {
    let payload: KCDMagicLinkPayload = {
      emailAddress,
      creationDate: new Date().toISOString(),
      validateSessionMagicLink: false,
    };
    let stringToEncrypt = JSON.stringify(payload);
    let encryptedString = this.encrypt(stringToEncrypt);
    let url = new URL(domainUrl);
    url.pathname = "magic";
    url.searchParams.set(this.magicLinkSearchParam, encryptedString);
    return url.toString();
  }

  private async sendToken(emailAddress: string, domainUrl: string) {
    let magicLink = this.getMagicLink(emailAddress, domainUrl);

    let user = await this.verify(emailAddress).catch(() => null);

    await this.sendEmail({
      emailAddress,
      magicLink,
      user,
      domainUrl,
    });

    return magicLink;
  }

  private encrypt(text: string): string {
    let iv = crypto.randomBytes(this.ivLength);
    let cipher = crypto.createCipheriv(this.algorithm, this.encryptionKey, iv);
    let encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
    return `${iv.toString("hex")}:${encrypted.toString("hex")}`;
  }

  private decrypt(text: string): string {
    let [ivPart, encryptedPart] = text.split(":");
    if (!ivPart || !encryptedPart) {
      throw new Error("Invalid text.");
    }

    let iv = Buffer.from(ivPart, "hex");
    let encryptedText = Buffer.from(encryptedPart, "hex");
    let decipher = crypto.createDecipheriv(
      this.algorithm,
      this.encryptionKey,
      iv
    );
    let decrypted = Buffer.concat([
      decipher.update(encryptedText),
      decipher.final(),
    ]);
    return decrypted.toString();
  }

  private getMagicLinkCode(link: string) {
    try {
      let url = new URL(link);
      return url.searchParams.get(this.magicLinkSearchParam) ?? "";
    } catch {
      return "";
    }
  }

  private validateMagicLink(requestUrl: string, sessionMagicLink?: string) {
    let linkCode = this.getMagicLinkCode(requestUrl);
    let sessionLinkCode = sessionMagicLink
      ? this.getMagicLinkCode(sessionMagicLink)
      : null;

    let emailAddress, linkCreationDateString, validateSessionMagicLink;
    try {
      let decryptedString = this.decrypt(linkCode);
      let payload = JSON.parse(decryptedString) as KCDMagicLinkPayload;
      emailAddress = payload.emailAddress;
      linkCreationDateString = payload.creationDate;
      validateSessionMagicLink = payload.validateSessionMagicLink;
    } catch (error: unknown) {
      console.error(error);
      throw new Error("Sign in link invalid. Please request a new one.");
    }

    if (typeof emailAddress !== "string") {
      console.error(`Email is not a string. Maybe wasn't set in the session?`);
      throw new Error("Sign in link invalid. Please request a new one.");
    }

    if (validateSessionMagicLink) {
      if (!sessionLinkCode) {
        console.error(
          "Must validate session magic link but no session link provided"
        );
        throw new Error("Sign in link invalid. Please request a new one.");
      }
      if (linkCode !== sessionLinkCode) {
        console.error(`Magic link does not match sessionMagicLink`);
        throw new Error(
          `You must open the magic link on the same device it was created from for security reasons. Please request a new link.`
        );
      }
    }

    if (typeof linkCreationDateString !== "string") {
      console.error("Link expiration is not a string.");
      throw new Error("Sign in link invalid. Please request a new one.");
    }

    let linkCreationDate = new Date(linkCreationDateString);
    let expirationTime = linkCreationDate.getTime() + this.linkExpirationTime;
    if (Date.now() > expirationTime) {
      throw new Error("Magic link expired. Please request a new one.");
    }
    return emailAddress;
  }
}