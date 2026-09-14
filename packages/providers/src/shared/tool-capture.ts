import type { ToolResultCapture } from '../types';

/** Capture the returned representation; native tool internals may retain more. */
export function captureToolResult(value: unknown): ToolResultCapture {
  const unavailable: ToolResultCapture = {
    text: '',
    format: 'text',
    completeness: 'unavailable',
    attachments: [],
  };
  if (value === undefined) return unavailable;
  if (typeof value === 'string') {
    return { text: value, format: 'text', completeness: 'full', attachments: [] };
  }
  const attachments: ToolResultCapture['attachments'] = [];
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (
        item !== null &&
        typeof item === 'object' &&
        'type' in item &&
        item.type === 'image' &&
        'data' in item &&
        typeof item.data === 'string'
      ) {
        const mediaType = 'mimeType' in item ? item.mimeType : undefined;
        if (typeof mediaType !== 'string' || !mediaType.startsWith('image/')) {
          throw new Error('unsupported image media type');
        }
        const data = Buffer.from(item.data, 'base64');
        if (data.length === 0 || data.toString('base64') !== item.data) {
          throw new Error('invalid image encoding');
        }
        const attachment = attachments.length;
        attachments.push({ data, mediaType });
        return { type: 'image', attachment, mediaType };
      }
      return item;
    });
    if (text === undefined) return unavailable;
    return { text, format: 'json', completeness: 'full', attachments };
  } catch {
    return unavailable;
  }
}
