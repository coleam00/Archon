export interface ZulipMessage {
  id: number;
  sender_id: number;
  sender_email: string;
  sender_full_name: string;
  content: string;
  type: 'stream' | 'private';
  stream_id?: number;
  subject?: string;
  display_recipient: string | { id: number; email: string; full_name: string }[];
}

export interface ZulipEvent {
  type: string;
  id: number;
  message?: ZulipMessage;
}

export type ZulipReplyContext =
  | { type: 'stream'; stream_id: number; topic: string }
  | { type: 'private'; user_ids: number[] };
