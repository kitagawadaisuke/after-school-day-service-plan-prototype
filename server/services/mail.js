import nodemailer from "nodemailer";

export function createMailService(config, { createTransport = nodemailer.createTransport } = {}) {
  if (!config?.mail) return null;
  const transport = createTransport({
    host: config.mail.host,
    port: config.mail.port,
    secure: config.mail.secure,
    requireTLS: config.mail.requireTLS,
    auth: { user: config.mail.username, pass: config.mail.password },
  });
  return Object.freeze({
    async sendPasswordSetup({ to, displayName, setupUrl }) {
      await transport.sendMail({
        from: config.mail.from,
        to,
        subject: "【放課後デイサービス COCO】パスワードの設定・再設定",
        text: `${displayName} 様\n\n放課後デイサービス COCO のパスワード設定です。以下のリンクからパスワードを設定してください。\n${setupUrl}\n\nこのリンクは30分間のみ有効です。心当たりがない場合は、このメールを破棄してください。`,
      });
    },
    async sendSignupPasswordSetup({ to, displayName, setupUrl }) {
      await transport.sendMail({
        from: config.mail.from,
        to,
        subject: "【放課後デイサービス COCO】登録を受け付けました",
        text: `${displayName} 様\n\n放課後デイサービス COCO への登録を受け付けました。以下のリンクからパスワードを設定すると、登録が完了します。\n${setupUrl}\n\nこのリンクは30分間のみ有効です。心当たりがない場合は、このメールを破棄してください。`,
      });
    },
    async sendPasswordSetupCompleted({ to, displayName, purpose }) {
      const isSignup = purpose === "signup";
      await transport.sendMail({
        from: config.mail.from,
        to,
        subject: isSignup ? "【放課後デイサービス COCO】登録が完了しました" : "【放課後デイサービス COCO】パスワードを変更しました",
        text: isSignup
          ? `${displayName} 様\n\n放課後デイサービス COCO への登録が完了しました。ログイン画面からご利用いただけます。`
          : `${displayName} 様\n\nパスワードを変更しました。心当たりがない場合は、管理者へご連絡ください。`,
      });
    },
  });
}
