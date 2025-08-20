/**
 * Unit tests for projectService document CRUD operations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Document } from '../../src/services/projectService';

// Mock fetch globally
global.fetch = vi.fn();

describe('projectService Document Operations', () => {
  let projectService: any;

  beforeEach(async () => {
    // Reset all mocks
    vi.resetAllMocks();
    vi.resetModules();
    
    // Import fresh instance of projectService
    const module = await import('../../src/services/projectService');
    projectService = module.projectService;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getDocument', () => {
    const mockDocument: Document = {
      id: 'doc-123',
      project_id: 'proj-456',
      title: 'Test Document',
      content: { type: 'markdown', text: 'Test content' },
      document_type: 'prp',
      metadata: { version: '1.0' },
      tags: ['test', 'sample'],
      author: 'test-user',
      created_at: '2025-08-18T10:00:00Z',
      updated_at: '2025-08-18T10:00:00Z'
    };

    it('should successfully fetch a document', async () => {
      // Mock successful response
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ document: mockDocument })
      });

      const result = await projectService.getDocument('proj-456', 'doc-123');

      expect(result).toEqual(mockDocument);
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/proj-456/docs/doc-123',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json'
          })
        })
      );
    });

    it('should include projectId in error message when fetch fails', async () => {
      // Mock failed response
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => '{"error": "Document not found"}'
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(projectService.getDocument('proj-456', 'doc-123')).rejects.toThrow();
      
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to get document doc-123 from project proj-456:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    it('should handle network errors', async () => {
      // Mock network error
      (global.fetch as any).mockRejectedValueOnce(new Error('Network error'));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(projectService.getDocument('proj-456', 'doc-123')).rejects.toThrow('Network error');
      
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to get document doc-123 from project proj-456:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });

  describe('updateDocument', () => {
    const mockUpdatedDocument: Document = {
      id: 'doc-123',
      project_id: 'proj-456',
      title: 'Updated Document',
      content: { type: 'markdown', text: 'Updated content' },
      document_type: 'prp',
      metadata: { version: '2.0' },
      tags: ['updated', 'test'],
      author: 'test-user',
      created_at: '2025-08-18T10:00:00Z',
      updated_at: '2025-08-18T11:00:00Z'
    };

    const updates = {
      title: 'Updated Document',
      content: { type: 'markdown', text: 'Updated content' },
      tags: ['updated', 'test']
    };

    it('should successfully update a document', async () => {
      // Mock successful response
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ document: mockUpdatedDocument })
      });

      const result = await projectService.updateDocument('proj-456', 'doc-123', updates);

      expect(result).toEqual(mockUpdatedDocument);
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/proj-456/docs/doc-123',
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            'Content-Type': 'application/json'
          }),
          body: JSON.stringify(updates)
        })
      );
    });

    it('should include projectId in error message when update fails', async () => {
      // Mock failed response
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => '{"error": "Invalid update data"}'
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(projectService.updateDocument('proj-456', 'doc-123', updates)).rejects.toThrow();
      
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to update document doc-123 in project proj-456:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    it('should handle partial updates', async () => {
      const partialUpdate = { title: 'Only Title Updated' };
      
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ document: { ...mockUpdatedDocument, title: 'Only Title Updated' } })
      });

      const result = await projectService.updateDocument('proj-456', 'doc-123', partialUpdate);

      expect(result.title).toBe('Only Title Updated');
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/proj-456/docs/doc-123',
        expect.objectContaining({
          body: JSON.stringify(partialUpdate)
        })
      );
    });
  });

  describe('deleteDocument', () => {
    it('should successfully delete a document', async () => {
      // Mock successful response
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({})
      });

      await expect(projectService.deleteDocument('proj-456', 'doc-123')).resolves.toBeUndefined();

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/proj-456/docs/doc-123',
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({
            'Content-Type': 'application/json'
          })
        })
      );
    });

    it('should include projectId in error message when deletion fails', async () => {
      // Mock failed response
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '{"error": "Permission denied"}'
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(projectService.deleteDocument('proj-456', 'doc-123')).rejects.toThrow();
      
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to delete document doc-123 from project proj-456:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    it('should handle 404 errors appropriately', async () => {
      // Mock 404 response
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => '{"error": "Document not found"}'
      });

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(projectService.deleteDocument('proj-456', 'doc-123')).rejects.toThrow();
      
      // Verify the error is logged with project context
      expect(consoleSpy).toHaveBeenCalled();
      const errorLog = consoleSpy.mock.calls[0];
      expect(errorLog[0]).toContain('proj-456');
      expect(errorLog[0]).toContain('doc-123');

      consoleSpy.mockRestore();
    });

    it('should handle network timeouts', async () => {
      // Mock timeout error
      const timeoutError = new Error('Request timeout');
      (global.fetch as any).mockRejectedValueOnce(timeoutError);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(projectService.deleteDocument('proj-456', 'doc-123')).rejects.toThrow('Failed to call API');
      
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to delete document doc-123 from project proj-456:',
        expect.objectContaining({
          message: expect.stringContaining('Request timeout')
        })
      );

      consoleSpy.mockRestore();
    });
  });

  describe('listProjectDocuments', () => {
    const mockDocuments: Document[] = [
      {
        id: 'doc-1',
        project_id: 'proj-456',
        title: 'Document 1',
        content: { type: 'markdown', text: 'Content 1' },
        document_type: 'prp',
        created_at: '2025-08-18T10:00:00Z',
        updated_at: '2025-08-18T10:00:00Z'
      },
      {
        id: 'doc-2',
        project_id: 'proj-456',
        title: 'Document 2',
        content: { type: 'markdown', text: 'Content 2' },
        document_type: 'spec',
        created_at: '2025-08-18T11:00:00Z',
        updated_at: '2025-08-18T11:00:00Z'
      }
    ];

    it('should successfully list all project documents', async () => {
      // Mock successful response
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ documents: mockDocuments })
      });

      const result = await projectService.listProjectDocuments('proj-456');

      expect(result).toEqual(mockDocuments);
      expect(result).toHaveLength(2);
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/proj-456/docs',
        expect.objectContaining({
          headers: expect.objectContaining({
            'Content-Type': 'application/json'
          })
        })
      );
    });

    it('should return empty array when no documents exist', async () => {
      // Mock response with no documents
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ documents: [] })
      });

      const result = await projectService.listProjectDocuments('proj-456');

      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });

    it('should handle null documents field gracefully', async () => {
      // Mock response with null documents
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ documents: null })
      });

      const result = await projectService.listProjectDocuments('proj-456');

      expect(result).toEqual([]);
    });
  });

  describe('createDocument', () => {
    const newDocumentData = {
      title: 'New Document',
      content: { type: 'markdown', text: 'New content' },
      document_type: 'prp',
      tags: ['new', 'test']
    };

    const mockCreatedDocument: Document = {
      id: 'doc-new',
      project_id: 'proj-456',
      ...newDocumentData,
      author: 'test-user',
      created_at: '2025-08-18T12:00:00Z',
      updated_at: '2025-08-18T12:00:00Z'
    };

    it('should successfully create a new document', async () => {
      // Mock successful response
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ document: mockCreatedDocument })
      });

      const result = await projectService.createDocument('proj-456', newDocumentData);

      expect(result).toEqual(mockCreatedDocument);
      expect(result.id).toBeDefined();
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/proj-456/docs',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json'
          }),
          body: JSON.stringify(newDocumentData)
        })
      );
    });

    it('should handle validation errors', async () => {
      // Mock validation error response
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => '{"error": "Title is required"}'
      });

      const invalidData = { content: 'Missing title' };
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await expect(projectService.createDocument('proj-456', invalidData)).rejects.toThrow();
      
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to create document for project proj-456:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });
});