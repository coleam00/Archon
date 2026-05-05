export interface MattermostMessageEvent {
  text: string;
  user: string;
  channel: string;
  postId: string;
  root_id?: string;
}

export interface MattermostPost {
  id: string;
  user_id: string;
  channel_id: string;
  message: string;
  root_id?: string;
}

export interface MattermostChannel {
  id: string;
  type: string;
}

export interface MattermostUser {
  id: string;
  username: string;
}

export interface MattermostThreadResponse {
  order: string[];
  posts: Record<string, MattermostPost>;
}

export interface MattermostWebSocketEnvelope {
  event?: string;
  data?: {
    post?: string;
  };
}
