/**
 * Tests for Knowledge Utilities
 */

import {
  resolveCrawlConfig,
  resolveEditUrl,
  resolveKnowledgeType,
  resolveMaxDepth,
  resolveTags,
  resolveConfigValue
} from './knowledge-utils';
import type { KnowledgeItem } from '../types';

describe('Knowledge Utilities', () => {
  describe('resolveConfigValue', () => {
    it('should prioritize top-level properties over metadata', () => {
      const item: Partial<KnowledgeItem> = {
        tags: ['top-level'],
        metadata: {
          tags: ['metadata-level']
        }
      };

      const result = resolveConfigValue(item as KnowledgeItem, 'tags', []);
      expect(result).toEqual(['top-level']);
    });

    it('should fall back to metadata when top-level is undefined', () => {
      const item: Partial<KnowledgeItem> = {
        metadata: {
          knowledge_type: 'business'
        }
      };

      const result = resolveConfigValue(item as KnowledgeItem, 'knowledge_type', 'technical');
      expect(result).toBe('business');
    });

    it('should use default value when both are undefined', () => {
      const item: Partial<KnowledgeItem> = {
        metadata: {}
      };

      const result = resolveConfigValue(item as KnowledgeItem, 'max_depth', 5);
      expect(result).toBe(5);
    });
  });

  describe('resolveCrawlConfig', () => {
    it('should prioritize top-level crawl_config', () => {
      const item: Partial<KnowledgeItem> = {
        crawl_config: {
          allowed_domains: ['top-level.com'],
          excluded_domains: [],
          include_patterns: [],
          exclude_patterns: []
        },
        metadata: {
          crawl_config: {
            allowed_domains: ['metadata-level.com'],
            excluded_domains: [],
            include_patterns: [],
            exclude_patterns: []
          }
        }
      };

      const result = resolveCrawlConfig(item as KnowledgeItem);
      expect(result.allowed_domains).toEqual(['top-level.com']);
    });

    it('should fall back to metadata crawl_config', () => {
      const item: Partial<KnowledgeItem> = {
        metadata: {
          crawl_config: {
            allowed_domains: ['metadata.com'],
            excluded_domains: ['excluded.com'],
            include_patterns: ['/docs/*'],
            exclude_patterns: ['/private/*']
          }
        }
      };

      const result = resolveCrawlConfig(item as KnowledgeItem);
      expect(result).toEqual({
        allowed_domains: ['metadata.com'],
        excluded_domains: ['excluded.com'],
        include_patterns: ['/docs/*'],
        exclude_patterns: ['/private/*']
      });
    });

    it('should return empty config when none exists', () => {
      const item: Partial<KnowledgeItem> = {
        metadata: {}
      };

      const result = resolveCrawlConfig(item as KnowledgeItem);
      expect(result).toEqual({
        allowed_domains: [],
        excluded_domains: [],
        include_patterns: [],
        exclude_patterns: []
      });
    });

    it('should handle malformed config gracefully', () => {
      const item: Partial<KnowledgeItem> = {
        crawl_config: {
          allowed_domains: 'not-an-array',
          excluded_domains: null,
          include_patterns: undefined,
          exclude_patterns: ['valid-pattern']
        } as any
      };

      const result = resolveCrawlConfig(item as KnowledgeItem);
      expect(result).toEqual({
        allowed_domains: [],
        excluded_domains: [],
        include_patterns: [],
        exclude_patterns: ['valid-pattern']
      });
    });
  });

  describe('resolveEditUrl', () => {
    it('should prioritize original_url from metadata', () => {
      const item: Partial<KnowledgeItem> = {
        url: 'https://current.com',
        metadata: {
          original_url: 'https://original.com'
        }
      };

      const result = resolveEditUrl(item as KnowledgeItem);
      expect(result).toBe('https://original.com');
    });

    it('should fall back to item url', () => {
      const item: Partial<KnowledgeItem> = {
        url: 'https://fallback.com',
        metadata: {}
      };

      const result = resolveEditUrl(item as KnowledgeItem);
      expect(result).toBe('https://fallback.com');
    });

    it('should return empty string when both are missing', () => {
      const item: Partial<KnowledgeItem> = {
        metadata: {}
      };

      const result = resolveEditUrl(item as KnowledgeItem);
      expect(result).toBe('');
    });
  });

  describe('resolveMaxDepth', () => {
    it('should prioritize top-level max_depth', () => {
      const item: Partial<KnowledgeItem> = {
        max_depth: 5,
        metadata: {
          max_depth: 3
        }
      };

      const result = resolveMaxDepth(item as KnowledgeItem);
      expect(result).toBe(5);
    });

    it('should fall back to metadata max_depth', () => {
      const item: Partial<KnowledgeItem> = {
        metadata: {
          max_depth: 3
        }
      };

      const result = resolveMaxDepth(item as KnowledgeItem);
      expect(result).toBe(3);
    });

    it('should return default of 2 when undefined', () => {
      const item: Partial<KnowledgeItem> = {
        metadata: {}
      };

      const result = resolveMaxDepth(item as KnowledgeItem);
      expect(result).toBe(2);
    });

    it('should handle non-number values', () => {
      const item: Partial<KnowledgeItem> = {
        max_depth: 'not-a-number' as any,
        metadata: {}
      };

      const result = resolveMaxDepth(item as KnowledgeItem);
      expect(result).toBe(2);
    });
  });

  describe('resolveTags', () => {
    it('should prioritize top-level tags', () => {
      const item: Partial<KnowledgeItem> = {
        tags: ['top-tag'],
        metadata: {
          tags: ['meta-tag']
        }
      };

      const result = resolveTags(item as KnowledgeItem);
      expect(result).toEqual(['top-tag']);
    });

    it('should fall back to metadata tags', () => {
      const item: Partial<KnowledgeItem> = {
        metadata: {
          tags: ['meta-tag1', 'meta-tag2']
        }
      };

      const result = resolveTags(item as KnowledgeItem);
      expect(result).toEqual(['meta-tag1', 'meta-tag2']);
    });

    it('should return empty array when undefined', () => {
      const item: Partial<KnowledgeItem> = {
        metadata: {}
      };

      const result = resolveTags(item as KnowledgeItem);
      expect(result).toEqual([]);
    });

    it('should handle non-array values', () => {
      const item: Partial<KnowledgeItem> = {
        tags: 'not-an-array' as any,
        metadata: {}
      };

      const result = resolveTags(item as KnowledgeItem);
      expect(result).toEqual([]);
    });
  });

  describe('resolveKnowledgeType', () => {
    it('should prioritize top-level knowledge_type', () => {
      const item: Partial<KnowledgeItem> = {
        knowledge_type: 'business',
        metadata: {
          knowledge_type: 'technical'
        }
      };

      const result = resolveKnowledgeType(item as KnowledgeItem);
      expect(result).toBe('business');
    });

    it('should fall back to metadata knowledge_type', () => {
      const item: Partial<KnowledgeItem> = {
        metadata: {
          knowledge_type: 'business'
        }
      };

      const result = resolveKnowledgeType(item as KnowledgeItem);
      expect(result).toBe('business');
    });

    it('should return technical as default', () => {
      const item: Partial<KnowledgeItem> = {
        metadata: {}
      };

      const result = resolveKnowledgeType(item as KnowledgeItem);
      expect(result).toBe('technical');
    });

    it('should handle invalid values by defaulting to technical', () => {
      const item: Partial<KnowledgeItem> = {
        knowledge_type: 'invalid-type' as any,
        metadata: {}
      };

      const result = resolveKnowledgeType(item as KnowledgeItem);
      expect(result).toBe('technical');
    });
  });
});