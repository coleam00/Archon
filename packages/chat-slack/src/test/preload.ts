import { mock } from 'bun:test';
import * as contract from '@archon/chat-contract';
import { App, LogLevel } from './bolt';
import { serveFixture } from './driver';
mock.module('@slack/bolt', () => ({ App, LogLevel }));
mock.module('@archon/chat-contract', () => ({ ...contract, serveChat: serveFixture }));
