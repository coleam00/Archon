import { slack } from './driver';
export const LogLevel = { ERROR: 'error' };
export class App {
  constructor() {
    return slack;
  }
}
