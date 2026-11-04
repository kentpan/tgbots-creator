export {};

declare global {
  interface TelegramWebAppUser {
    id: number;
    is_bot?: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
    language_code?: string;
    is_premium?: boolean;
    photo_url?: string;
  }

  interface TelegramWebApp {
    initData: string;
    initDataUnsafe: {
      user?: TelegramWebAppUser;
      start_param?: string;
    };
    version: string;
    platform: string;
    colorScheme: string;
    ready(): void;
    expand(): void;
    close(): void;
    setHeaderColor(color: string): void;
    setBackgroundColor(color: string): void;
    enableClosingConfirmation(): void;
    disableClosingConfirmation(): void;
    BackButton: {
      show(): void;
      hide(): void;
      onClick(cb: () => void): void;
      offClick(cb?: () => void): void;
    };
    MainButton: {
      text: string;
      isVisible: boolean;
      setText(text: string): void;
      show(): void;
      hide(): void;
      enable(): void;
      disable(): void;
      onClick(cb: () => void): void;
      offClick(cb?: () => void): void;
    };
    HapticFeedback?: {
      notificationOccurred(type: "error" | "success" | "warning"): void;
      impactOccurred(style: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
      selectionChanged(): void;
    };
    openLink(url: string, options?: { try_instant_view?: boolean }): void;
    openTelegramLink(url: string): void;
  }

  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
    hcaptcha?: {
      render(container: string | HTMLElement, params: Record<string, unknown>): string;
      reset(id?: string): void;
      getRespKey(id?: string): string;
      getResponse(id?: string): string;
    };
    turnstile?: {
      render(container: string | HTMLElement, params: Record<string, unknown>): string;
      reset(widgetIdOrContainer?: string): void;
      getResponse(widgetIdOrContainer?: string): string;
    };
  }
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "cap-widget": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          "data-cap-api-endpoint"?: string;
          "data-cap-lang"?: string;
        },
        HTMLElement
      >;
    }
  }
}
