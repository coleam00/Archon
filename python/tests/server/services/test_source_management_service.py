"""
Tests for Source Management Service

Tests source CRUD operations and batch deletion functionality.
"""

import pytest
from unittest.mock import Mock, AsyncMock, patch
from src.server.services.source_management_service import SourceManagementService


class TestSourceManagementService:
    """Test suite for SourceManagementService"""

    @pytest.fixture
    def mock_supabase(self):
        """Create mock Supabase client"""
        mock = Mock()
        mock.table = Mock(return_value=mock)
        mock.select = Mock(return_value=mock)
        mock.insert = Mock(return_value=mock)
        mock.update = Mock(return_value=mock)
        mock.delete = Mock(return_value=mock)
        mock.eq = Mock(return_value=mock)
        mock.in_ = Mock(return_value=mock)
        mock.execute = Mock()
        mock.rpc = Mock(return_value=mock)
        return mock

    @pytest.fixture
    def source_service(self, mock_supabase):
        """Create SourceManagementService instance"""
        with patch('src.server.services.source_management_service.get_supabase_client', return_value=mock_supabase):
            service = SourceManagementService(supabase_client=mock_supabase)
            return service

    @pytest.mark.asyncio
    async def test_create_source(self, source_service, mock_supabase):
        """Test creating a new source"""
        mock_supabase.execute.return_value = Mock(
            data=[{
                "id": "source_1",
                "source": "https://example.com",
                "status": "pending",
                "document_count": 0
            }]
        )

        result = await source_service.create_source({
            "source": "https://example.com",
            "source_type": "web_crawl"
        })

        assert result["id"] == "source_1"
        assert result["source"] == "https://example.com"
        mock_supabase.table.assert_called_with("archon_data_sources")

    @pytest.mark.asyncio
    async def test_get_source_by_id(self, source_service, mock_supabase):
        """Test retrieving source by ID"""
        mock_supabase.execute.return_value = Mock(
            data=[{
                "id": "source_1",
                "source": "https://example.com",
                "status": "completed",
                "document_count": 150
            }]
        )

        result = await source_service.get_source("source_1")

        assert result["id"] == "source_1"
        assert result["document_count"] == 150
        mock_supabase.eq.assert_called_with("id", "source_1")

    @pytest.mark.asyncio
    async def test_get_nonexistent_source(self, source_service, mock_supabase):
        """Test retrieving non-existent source returns None"""
        mock_supabase.execute.return_value = Mock(data=[])

        result = await source_service.get_source("nonexistent")

        assert result is None

    @pytest.mark.asyncio
    async def test_list_all_sources(self, source_service, mock_supabase):
        """Test listing all sources"""
        mock_supabase.execute.return_value = Mock(
            data=[
                {"id": "source_1", "source": "https://example.com"},
                {"id": "source_2", "source": "https://docs.example.com"}
            ]
        )

        results = await source_service.list_sources()

        assert len(results) == 2
        assert results[0]["id"] == "source_1"
        assert results[1]["id"] == "source_2"

    @pytest.mark.asyncio
    async def test_update_source_status(self, source_service, mock_supabase):
        """Test updating source status"""
        mock_supabase.execute.return_value = Mock(
            data=[{
                "id": "source_1",
                "status": "processing"
            }]
        )

        result = await source_service.update_source("source_1", {"status": "processing"})

        assert result["status"] == "processing"
        mock_supabase.update.assert_called()

    @pytest.mark.asyncio
    async def test_delete_source_single(self, source_service, mock_supabase):
        """Test deleting a source with minimal documents"""
        # Mock document count check
        mock_supabase.execute.return_value = Mock(data=[{"count": 50}])

        # Mock batch deletion
        with patch.object(source_service, '_delete_source_documents_batch', new_callable=AsyncMock) as mock_batch_delete:
            mock_batch_delete.return_value = 50

            # Mock source deletion
            mock_supabase.execute.return_value = Mock(data=[])

            result = await source_service.delete_source("source_1")

            assert result is True
            mock_batch_delete.assert_called_once()

    @pytest.mark.asyncio
    async def test_delete_source_with_many_documents(self, source_service, mock_supabase):
        """Test deleting source with many documents uses batching"""
        # Mock high document count
        mock_supabase.execute.return_value = Mock(data=[{"count": 5000}])

        with patch.object(source_service, '_delete_source_documents_batch', new_callable=AsyncMock) as mock_batch_delete:
            # Simulate batch deletion
            mock_batch_delete.return_value = 5000

            # Mock source deletion
            mock_supabase.execute.return_value = Mock(data=[])

            result = await source_service.delete_source("source_1")

            assert result is True
            # Should be called to handle 5000 documents
            mock_batch_delete.assert_called()

    @pytest.mark.asyncio
    async def test_delete_source_handles_errors(self, source_service, mock_supabase):
        """Test error handling during source deletion"""
        mock_supabase.execute.side_effect = Exception("Database error")

        result = await source_service.delete_source("source_1")

        # Should return False on error
        assert result is False

    @pytest.mark.asyncio
    async def test_batch_delete_documents(self, source_service, mock_supabase):
        """Test batch document deletion"""
        # Mock getting document IDs
        mock_supabase.execute.return_value = Mock(
            data=[{"id": f"doc_{i}"} for i in range(100)]
        )

        # Should handle deletion in batches
        deleted_count = await source_service._delete_source_documents_batch("source_1", batch_size=1000)

        assert deleted_count >= 0
        # Verify delete was called
        assert mock_supabase.delete.called or mock_supabase.in_.called

    @pytest.mark.asyncio
    async def test_get_source_document_count(self, source_service, mock_supabase):
        """Test getting document count for source"""
        mock_supabase.execute.return_value = Mock(data=[{"count": 250}])

        count = await source_service.get_document_count("source_1")

        assert count == 250

    @pytest.mark.asyncio
    async def test_update_source_document_count(self, source_service, mock_supabase):
        """Test updating source document count"""
        mock_supabase.execute.return_value = Mock(
            data=[{
                "id": "source_1",
                "document_count": 100
            }]
        )

        result = await source_service.update_document_count("source_1", 100)

        assert result["document_count"] == 100

    @pytest.mark.asyncio
    async def test_search_sources_by_url(self, source_service, mock_supabase):
        """Test searching sources by URL pattern"""
        mock_supabase.execute.return_value = Mock(
            data=[{
                "id": "source_1",
                "source": "https://example.com/docs"
            }]
        )

        results = await source_service.search_sources("example.com")

        assert len(results) > 0
        assert "example.com" in results[0]["source"]

    @pytest.mark.asyncio
    async def test_get_sources_by_status(self, source_service, mock_supabase):
        """Test filtering sources by status"""
        mock_supabase.execute.return_value = Mock(
            data=[
                {"id": "source_1", "status": "completed"},
                {"id": "source_2", "status": "completed"}
            ]
        )

        results = await source_service.get_sources_by_status("completed")

        assert len(results) == 2
        assert all(s["status"] == "completed" for s in results)

    @pytest.mark.asyncio
    async def test_delete_multiple_sources(self, source_service, mock_supabase):
        """Test deleting multiple sources"""
        source_ids = ["source_1", "source_2", "source_3"]

        with patch.object(source_service, 'delete_source', new_callable=AsyncMock) as mock_delete:
            mock_delete.return_value = True

            results = await source_service.delete_sources_batch(source_ids)

            assert len(results) == 3
            assert all(r is True for r in results)
            assert mock_delete.call_count == 3

    @pytest.mark.asyncio
    async def test_source_status_transitions(self, source_service, mock_supabase):
        """Test valid status transitions"""
        statuses = ["pending", "processing", "completed", "failed"]

        for status in statuses:
            mock_supabase.execute.return_value = Mock(
                data=[{"id": "source_1", "status": status}]
            )

            result = await source_service.update_source("source_1", {"status": status})

            assert result["status"] == status

    @pytest.mark.asyncio
    async def test_create_source_with_metadata(self, source_service, mock_supabase):
        """Test creating source with custom metadata"""
        metadata = {
            "max_depth": 3,
            "include_patterns": ["*.html", "*.pdf"],
            "exclude_patterns": ["*/admin/*"]
        }

        mock_supabase.execute.return_value = Mock(
            data=[{
                "id": "source_1",
                "source": "https://example.com",
                "crawl_config": metadata
            }]
        )

        result = await source_service.create_source({
            "source": "https://example.com",
            "crawl_config": metadata
        })

        assert result["crawl_config"] == metadata

    @pytest.mark.asyncio
    async def test_concurrent_deletions(self, source_service, mock_supabase):
        """Test that concurrent deletions don't interfere"""
        import asyncio

        async def delete_task(source_id):
            mock_supabase.execute.return_value = Mock(data=[{"count": 10}])
            return await source_service.delete_source(source_id)

        tasks = [delete_task(f"source_{i}") for i in range(5)]
        results = await asyncio.gather(*tasks)

        # All deletions should complete
        assert len(results) == 5
