"""Test text_search error handling improvements."""

import unittest
from unittest.mock import Mock, patch
import pytest
from postgrest.exceptions import APIError

from src.server.repositories.implementations.supabase_repositories import (
    SupabaseDocumentRepository,
    SupabaseCodeExampleRepository
)
from src.server.repositories.exceptions import QueryError, DatabaseOperationError


class TestTextSearchErrorHandling(unittest.TestCase):
    """Test that text_search methods properly propagate errors with stack traces."""
    
    def setUp(self):
        """Set up test fixtures."""
        self.mock_client = Mock()
        self.doc_repo = SupabaseDocumentRepository(self.mock_client)
        self.code_repo = SupabaseCodeExampleRepository(self.mock_client)
    
    @pytest.mark.asyncio
    async def test_document_search_content_api_error(self):
        """Test search_content handles APIError correctly."""
        # Simulate APIError from Supabase
        error_dict = {'message': 'text search configuration missing', 'code': '42P01'}
        api_error = APIError(error_dict)
        
        # Set up mock to raise APIError
        mock_query = Mock()
        mock_query.text_search.return_value = mock_query
        mock_query.eq.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.execute.side_effect = api_error
        
        self.mock_client.table.return_value.select.return_value = mock_query
        
        # Should raise QueryError with proper context
        with self.assertRaises(QueryError) as cm:
            await self.doc_repo.search_content("test query", limit=5)
        
        # Verify error details
        error = cm.exception
        self.assertIn("Text search query failed", str(error))
        self.assertEqual(error.query_type, "text_search")
        self.assertEqual(error.operation, "search_content")
        self.assertEqual(error.entity_type, "Document")
        self.assertIs(error.original_error, api_error)
        
        # Verify the exception chain is preserved
        self.assertIs(error.__cause__, api_error)
    
    @pytest.mark.asyncio
    async def test_document_search_content_unexpected_error(self):
        """Test search_content handles unexpected errors correctly."""
        # Simulate unexpected error
        unexpected_error = RuntimeError("Database connection lost")
        
        # Set up mock to raise unexpected error
        mock_query = Mock()
        mock_query.text_search.return_value = mock_query
        mock_query.eq.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.execute.side_effect = unexpected_error
        
        self.mock_client.table.return_value.select.return_value = mock_query
        
        # Should raise DatabaseOperationError with proper context
        with self.assertRaises(DatabaseOperationError) as cm:
            await self.doc_repo.search_content("long query text" * 20, limit=10, source_filter="test_source")
        
        # Verify error details
        error = cm.exception
        self.assertIn("Unexpected error during text search", str(error))
        self.assertIn("text_search on 'content'", error.query_info)
        self.assertEqual(error.operation, "search_content")
        self.assertEqual(error.entity_type, "Document")
        self.assertIs(error.original_error, unexpected_error)
        
        # Verify the exception chain is preserved
        self.assertIs(error.__cause__, unexpected_error)
    
    @pytest.mark.asyncio
    async def test_code_search_by_summary_api_error(self):
        """Test search_by_summary handles APIError correctly."""
        # Simulate APIError
        error_dict = {'message': 'invalid text search query', 'code': '22023'}
        api_error = APIError(error_dict)
        
        # Set up mock
        mock_query = Mock()
        mock_query.text_search.return_value = mock_query
        mock_query.eq.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.execute.side_effect = api_error
        
        self.mock_client.table.return_value.select.return_value = mock_query
        
        # Should raise QueryError
        with self.assertRaises(QueryError) as cm:
            await self.code_repo.search_by_summary("test", source_filter="source123")
        
        # Verify error context
        error = cm.exception
        self.assertIn("Text search on code examples failed", str(error))
        self.assertEqual(error.entity_type, "CodeExample")
        self.assertEqual(error.operation, "search_by_summary")
        self.assertIs(error.__cause__, api_error)
    
    @pytest.mark.asyncio
    async def test_code_search_content_unexpected_error(self):
        """Test search_code_content handles unexpected errors correctly."""
        # Simulate unexpected error
        unexpected_error = ValueError("Invalid language filter")
        
        # Set up mock
        mock_query = Mock()
        mock_query.text_search.return_value = mock_query
        mock_query.eq.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.execute.side_effect = unexpected_error
        
        self.mock_client.table.return_value.select.return_value = mock_query
        
        # Should raise DatabaseOperationError
        with self.assertRaises(DatabaseOperationError) as cm:
            await self.code_repo.search_code_content("function test", language_filter="python", limit=20)
        
        # Verify error context
        error = cm.exception
        self.assertIn("Unexpected error during code search", str(error))
        self.assertEqual(error.operation, "search_code_content")
        self.assertIs(error.__cause__, unexpected_error)
    
    @pytest.mark.asyncio
    async def test_search_succeeds_with_valid_response(self):
        """Test that search methods return data when successful."""
        # Set up successful mock response
        mock_response = Mock()
        mock_response.data = [
            {'id': '123', 'content': 'test content', 'source_id': 'src1'},
            {'id': '456', 'content': 'more content', 'source_id': 'src2'}
        ]
        
        mock_query = Mock()
        mock_query.text_search.return_value = mock_query
        mock_query.eq.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.execute.return_value = mock_response
        
        self.mock_client.table.return_value.select.return_value = mock_query
        
        # Should return data successfully
        results = await self.doc_repo.search_content("test", limit=10)
        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]['id'], '123')
        
    @pytest.mark.asyncio
    async def test_search_returns_empty_list_when_no_data(self):
        """Test that search methods return empty list when no results."""
        # Set up mock response with no data
        mock_response = Mock()
        mock_response.data = None
        
        mock_query = Mock()
        mock_query.text_search.return_value = mock_query
        mock_query.eq.return_value = mock_query
        mock_query.limit.return_value = mock_query
        mock_query.execute.return_value = mock_response
        
        self.mock_client.table.return_value.select.return_value = mock_query
        
        # Should return empty list
        results = await self.code_repo.search_by_summary("nonexistent")
        self.assertEqual(results, [])


if __name__ == '__main__':
    pytest.main([__file__, '-v'])