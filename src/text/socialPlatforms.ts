export const SOCIAL_TEXT_PLATFORMS = ["telegram", "max"] as const;

export type SocialTextPlatform = (typeof SOCIAL_TEXT_PLATFORMS)[number];

export type PreparedSocialTexts = Partial<Record<SocialTextPlatform, string>>;
