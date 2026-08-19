export interface TeamsClientConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  redirectUri: string;
}

/** Scopes requested at connect time — the minimum needed to read joined teams/channels/messages
 * and to keep working after the access token expires (`offline_access` -> a refresh_token comes
 * back from the token endpoint). See TEAMS_SETUP.md for the matching Azure App Registration
 * "API permissions" these correspond to. */
export const TEAMS_OAUTH_SCOPES = [
  "offline_access",
  "User.Read",
  "Team.ReadBasic.All",
  "Channel.ReadBasic.All",
  "ChannelMessage.Read.All",
] as const;

export interface TeamsTokenBundle {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry, not a duration — callers persist this directly. */
  expiresAt: Date;
  scopes: string[];
}

export interface TeamsGraphUser {
  id: string;
  mail: string | null;
  userPrincipalName: string;
  displayName: string;
}

export interface TeamsGraphTeam {
  id: string;
  displayName: string;
}

export interface TeamsGraphChannel {
  id: string;
  displayName: string;
  membershipType: string | null;
}

export interface TeamsGraphMessage {
  id: string;
  /** Null for a top-level channel message; set for a threaded reply. */
  replyToId: string | null;
  from: { userId: string; displayName: string } | null;
  /** Plain text, already stripped of the `contentType: "html"` wrapper Graph returns. */
  body: string;
  createdDateTime: string;
}
