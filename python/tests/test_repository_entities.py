"""
Tests for repository entity models and validation.

This module tests the Pydantic models used in the repository layer:
- Entity model validation and serialization
- Field validation and constraints
- Vector embedding validation
- Entity utility methods
- Error handling for invalid data
"""

import pytest
from datetime import datetime
from typing import Dict, Any, List
from uuid import UUID, uuid4
from pydantic import ValidationError

from src.server.models.entities import (
    BaseEntity,
    Source,
    Document,
    CodeExample
)


class TestBaseEntity:
    """Test the base entity model."""
    
    def test_base_entity_creation_minimal(self):
        """Test creating base entity with minimal fields."""
        entity = BaseEntity()
        
        assert entity.id is None
        assert entity.created_at is None
        assert entity.updated_at is None
    
    def test_base_entity_creation_with_fields(self):
        """Test creating base entity with all fields."""
        entity_id = uuid4()
        created_time = datetime.now()
        updated_time = datetime.now()
        
        entity = BaseEntity(
            id=entity_id,
            created_at=created_time,
            updated_at=updated_time
        )
        
        assert entity.id == entity_id
        assert entity.created_at == created_time
        assert entity.updated_at == updated_time
    
    def test_base_entity_id_types(self):
        """Test base entity accepts different ID types."""
        # UUID type
        uuid_entity = BaseEntity(id=uuid4())
        assert isinstance(uuid_entity.id, UUID)
        
        # String type
        str_entity = BaseEntity(id="string-id")
        assert isinstance(str_entity.id, str)
        
        # Integer type
        int_entity = BaseEntity(id=12345)
        assert isinstance(int_entity.id, int)
    
    def test_base_entity_serialization(self):
        """Test base entity can be serialized to dict."""
        entity = BaseEntity(id="test-id", created_at=datetime(2024, 1, 1))
        
        data = entity.model_dump()
        
        assert data["id"] == "test-id"
        assert data["created_at"] == datetime(2024, 1, 1)
        assert data["updated_at"] is None


class TestSourceEntity:
    """Test the Source entity model."""
    
    def test_source_creation_minimal(self):
        """Test creating source with minimal required fields."""
        source = Source(source_id="example.com")
        
        assert source.source_id == "example.com"
        assert source.source_type == "website"  # default value
        assert source.crawl_status == "pending"  # default value
        assert source.total_pages == 0  # default value
        assert source.pages_crawled == 0  # default value
        assert source.total_word_count == 0  # default value
        assert source.metadata == {}  # default value
    
    def test_source_creation_complete(self):
        """Test creating source with all fields."""
        metadata = {"language": "en", "content_type": "documentation"}
        
        source = Source(
            id="source-id",
            source_id="example.com",
            source_type="website",
            base_url="https://example.com",
            title="Example Website",
            summary="A test website for examples",
            crawl_status="completed",
            total_pages=100,
            pages_crawled=95,
            total_word_count=50000,
            metadata=metadata,
            created_at=datetime.now(),
            updated_at=datetime.now()
        )
        
        assert source.source_id == "example.com"
        assert source.source_type == "website"
        assert source.base_url == "https://example.com"
        assert source.title == "Example Website"
        assert source.summary == "A test website for examples"
        assert source.crawl_status == "completed"
        assert source.total_pages == 100
        assert source.pages_crawled == 95
        assert source.total_word_count == 50000
        assert source.metadata == metadata
    
    def test_source_missing_required_field(self):
        """Test that source creation fails without required fields."""
        with pytest.raises(ValidationError) as exc_info:
            Source()
        
        # Should complain about missing source_id
        errors = exc_info.value.errors()
        assert len(errors) > 0
        assert any(error["loc"] == ("source_id",) for error in errors)
    
    def test_source_is_completed_method(self):
        """Test the is_completed utility method."""
        # Completed source
        completed_source = Source(source_id="test", crawl_status="completed")
        assert completed_source.is_completed() is True
        
        # Non-completed sources
        pending_source = Source(source_id="test", crawl_status="pending")
        assert pending_source.is_completed() is False
        
        in_progress_source = Source(source_id="test", crawl_status="in_progress")
        assert in_progress_source.is_completed() is False
        
        failed_source = Source(source_id="test", crawl_status="failed")
        assert failed_source.is_completed() is False
    
    def test_source_progress_percentage_calculation(self):
        """Test the get_progress_percentage utility method."""
        # No pages
        empty_source = Source(source_id="test", total_pages=0, pages_crawled=0)
        assert empty_source.get_progress_percentage() == 0.0
        
        # None values
        none_source = Source(source_id="test", total_pages=None, pages_crawled=None)
        assert none_source.get_progress_percentage() == 0.0
        
        # Partial progress
        partial_source = Source(source_id="test", total_pages=10, pages_crawled=3)
        assert partial_source.get_progress_percentage() == 30.0
        
        # Complete progress
        complete_source = Source(source_id="test", total_pages=10, pages_crawled=10)
        assert complete_source.get_progress_percentage() == 100.0
        
        # Over-crawled (should cap at 100%)
        over_source = Source(source_id="test", total_pages=10, pages_crawled=15)
        assert over_source.get_progress_percentage() == 100.0
    
    def test_source_serialization(self):
        """Test source serialization to dict."""
        source = Source(
            source_id="example.com",
            source_type="website",
            title="Example Site",
            metadata={"key": "value"}
        )
        
        data = source.model_dump()
        
        assert data["source_id"] == "example.com"
        assert data["source_type"] == "website"
        assert data["title"] == "Example Site"
        assert data["metadata"] == {"key": "value"}
    
    def test_source_field_descriptions(self):
        """Test that source fields have proper descriptions."""
        source_fields = Source.model_fields
        
        assert "source_id" in source_fields
        assert "Unique identifier" in source_fields["source_id"].description
        
        assert "source_type" in source_fields
        assert "Type:" in source_fields["source_type"].description
        
        assert "crawl_status" in source_fields
        assert "Crawling status" in source_fields["crawl_status"].description


class TestDocumentEntity:
    """Test the Document entity model."""
    
    def test_document_creation_minimal(self):
        """Test creating document with minimal required fields."""
        document = Document(
            url="https://example.com/page1",
            chunk_number=0,
            content="This is test content",
            source_id="example.com"
        )
        
        assert document.url == "https://example.com/page1"
        assert document.chunk_number == 0
        assert document.content == "This is test content"
        assert document.source_id == "example.com"
        assert document.embedding is None
        assert document.metadata == {}
        assert document.similarity_score is None
    
    def test_document_creation_complete(self):
        """Test creating document with all fields."""
        embedding = [0.1, 0.2, 0.3, 0.4, 0.5]
        metadata = {"page_title": "Test Page", "language": "en"}
        
        document = Document(
            id="doc-id",
            url="https://example.com/page1",
            chunk_number=2,
            content="This is the third chunk of content",
            source_id="example.com",
            embedding=embedding,
            metadata=metadata,
            similarity_score=0.95,
            created_at=datetime.now(),
            updated_at=datetime.now()
        )
        
        assert document.url == "https://example.com/page1"
        assert document.chunk_number == 2
        assert document.content == "This is the third chunk of content"
        assert document.source_id == "example.com"
        assert document.embedding == embedding
        assert document.metadata == metadata
        assert document.similarity_score == 0.95
    
    def test_document_missing_required_fields(self):
        """Test that document creation fails without required fields."""
        with pytest.raises(ValidationError) as exc_info:
            Document()
        
        errors = exc_info.value.errors()
        required_fields = {"url", "chunk_number", "content", "source_id"}
        error_fields = {error["loc"][0] for error in errors}
        
        # All required fields should be in the error
        assert required_fields.issubset(error_fields)
    
    def test_document_embedding_validation(self):
        """Test document embedding field validation."""
        # Valid embedding (list of floats)
        valid_embedding = [0.1, 0.2, 0.3, 0.4, 0.5]
        document = Document(
            url="https://example.com",
            chunk_number=0,
            content="test",
            source_id="test",
            embedding=valid_embedding
        )
        assert document.embedding == valid_embedding
        
        # Empty embedding (should be allowed)
        empty_document = Document(
            url="https://example.com",
            chunk_number=0,
            content="test",
            source_id="test",
            embedding=[]
        )
        assert empty_document.embedding == []
    
    def test_document_char_count_method(self):
        """Test the get_char_count utility method."""
        # Normal content
        document = Document(
            url="https://example.com",
            chunk_number=0,
            content="Hello, World!",
            source_id="test"
        )
        assert document.get_char_count() == 13
        
        # Empty content
        empty_document = Document(
            url="https://example.com",
            chunk_number=0,
            content="",
            source_id="test"
        )
        assert empty_document.get_char_count() == 0
    
    def test_document_word_count_method(self):
        """Test the get_word_count utility method."""
        # Normal content
        document = Document(
            url="https://example.com",
            chunk_number=0,
            content="Hello world this is test content",
            source_id="test"
        )
        assert document.get_word_count() == 6
        
        # Empty content
        empty_document = Document(
            url="https://example.com",
            chunk_number=0,
            content="",
            source_id="test"
        )
        assert empty_document.get_word_count() == 0
        
        # Single word
        single_document = Document(
            url="https://example.com",
            chunk_number=0,
            content="Hello",
            source_id="test"
        )
        assert single_document.get_word_count() == 1
    
    def test_document_chunk_number_validation(self):
        """Test document chunk number validation."""
        # Valid chunk numbers
        for chunk_num in [0, 1, 10, 100]:
            document = Document(
                url="https://example.com",
                chunk_number=chunk_num,
                content="test",
                source_id="test"
            )
            assert document.chunk_number == chunk_num
    
    def test_document_similarity_score_validation(self):
        """Test document similarity score validation."""
        # Valid similarity scores
        for score in [0.0, 0.5, 1.0, 0.95]:
            document = Document(
                url="https://example.com",
                chunk_number=0,
                content="test",
                source_id="test",
                similarity_score=score
            )
            assert document.similarity_score == score


class TestCodeExampleEntity:
    """Test the CodeExample entity model."""
    
    def test_code_example_creation_minimal(self):
        """Test creating code example with minimal required fields."""
        code_example = CodeExample(
            url="https://example.com/code.py",
            chunk_number=0,
            source_id="example.com",
            content="print('Hello, World!')"  # Using alias name
        )
        
        assert code_example.url == "https://example.com/code.py"
        assert code_example.chunk_number == 0
        assert code_example.source_id == "example.com"
        assert code_example.code_block == "print('Hello, World!')"
        assert code_example.language is None
        assert code_example.summary is None
        assert code_example.embedding is None
        assert code_example.metadata == {}
        assert code_example.similarity_score is None
    
    def test_code_example_creation_complete(self):
        """Test creating code example with all fields."""
        code_block = """
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n-1) + fibonacci(n-2)
"""
        embedding = [0.1, 0.2, 0.3, 0.4, 0.5]
        metadata = {"function_name": "fibonacci", "complexity": "O(2^n)"}
        
        code_example = CodeExample(
            id="code-id",
            url="https://example.com/algorithms.py",
            chunk_number=1,
            source_id="example.com",
            content=code_block,
            language="python",
            summary="Recursive Fibonacci implementation",
            embedding=embedding,
            metadata=metadata,
            similarity_score=0.88,
            created_at=datetime.now(),
            updated_at=datetime.now()
        )
        
        assert code_example.url == "https://example.com/algorithms.py"
        assert code_example.chunk_number == 1
        assert code_example.source_id == "example.com"
        assert code_example.code_block == code_block
        assert code_example.language == "python"
        assert code_example.summary == "Recursive Fibonacci implementation"
        assert code_example.embedding == embedding
        assert code_example.metadata == metadata
        assert code_example.similarity_score == 0.88
    
    def test_code_example_missing_required_fields(self):
        """Test that code example creation fails without required fields."""
        with pytest.raises(ValidationError) as exc_info:
            CodeExample()
        
        errors = exc_info.value.errors()
        required_fields = {"url", "chunk_number", "source_id", "content"}
        error_fields = {error["loc"][0] for error in errors}
        
        # All required fields should be in the error
        assert required_fields.issubset(error_fields)
    
    def test_code_example_alias_field(self):
        """Test that code_block field has proper alias."""
        # Test using alias 'content'
        code_example = CodeExample(
            url="https://example.com",
            chunk_number=0,
            source_id="test",
            content="print('test')"  # Using alias
        )
        
        # Should map to code_block
        assert code_example.code_block == "print('test')"
    
    def test_code_example_get_code_length_method(self):
        """Test the get_code_length utility method."""
        # Normal code
        code_example = CodeExample(
            url="https://example.com",
            chunk_number=0,
            source_id="test",
            content="def hello():\n    print('Hello')"
        )
        assert code_example.get_code_length() == 31  # "def hello():\n    print('Hello')" is 31 chars
        
        # Empty code
        empty_example = CodeExample(
            url="https://example.com",
            chunk_number=0,
            source_id="test",
            content=""
        )
        assert empty_example.get_code_length() == 0
    
    def test_code_example_language_validation(self):
        """Test code example language field validation."""
        languages = ["python", "javascript", "typescript", "java", "cpp", "go", "rust"]
        
        for language in languages:
            code_example = CodeExample(
                url="https://example.com",
                chunk_number=0,
                source_id="test",
                content="// code here",
                language=language
            )
            assert code_example.language == language
    
    def test_code_example_embedding_handling(self):
        """Test code example embedding field handling."""
        # Large embedding (typical for code)
        large_embedding = [float(i) for i in range(1536)]  # OpenAI embedding size
        
        code_example = CodeExample(
            url="https://example.com",
            chunk_number=0,
            source_id="test",
            content="print('test')",
            embedding=large_embedding
        )
        
        assert len(code_example.embedding) == 1536
        assert all(isinstance(val, float) for val in code_example.embedding)
    
    def test_code_example_metadata_structure(self):
        """Test code example metadata field structure."""
        complex_metadata = {
            "functions": ["main", "helper"],
            "imports": ["os", "sys", "json"],
            "lines_of_code": 45,
            "complexity_metrics": {
                "cyclomatic_complexity": 3,
                "nesting_depth": 2
            },
            "detected_patterns": ["error_handling", "logging"]
        }
        
        code_example = CodeExample(
            url="https://example.com",
            chunk_number=0,
            source_id="test",
            content="# complex code here",
            metadata=complex_metadata
        )
        
        assert code_example.metadata == complex_metadata
        assert code_example.metadata["lines_of_code"] == 45
        assert "error_handling" in code_example.metadata["detected_patterns"]


class TestEntityValidation:
    """Test entity validation edge cases and error handling."""
    
    def test_invalid_uuid_handling(self):
        """Test handling of invalid UUID strings."""
        # Valid UUID string should work
        valid_uuid_str = str(uuid4())
        entity = BaseEntity(id=valid_uuid_str)
        assert entity.id == valid_uuid_str
        
        # Invalid UUID string should still be accepted as string
        invalid_uuid_str = "not-a-uuid"
        entity = BaseEntity(id=invalid_uuid_str)
        assert entity.id == invalid_uuid_str
    
    def test_datetime_validation(self):
        """Test datetime field validation."""
        # Valid datetime
        valid_datetime = datetime(2024, 1, 1, 12, 0, 0)
        entity = BaseEntity(created_at=valid_datetime)
        assert entity.created_at == valid_datetime
        
        # Current datetime
        current_datetime = datetime.now()
        entity = BaseEntity(created_at=current_datetime)
        assert entity.created_at == current_datetime
    
    def test_negative_numbers_in_source(self):
        """Test handling of negative numbers in source fields."""
        # Should accept negative numbers (might be edge case data)
        source = Source(
            source_id="test",
            total_pages=-1,
            pages_crawled=-5,
            total_word_count=-100
        )
        
        assert source.total_pages == -1
        assert source.pages_crawled == -5
        assert source.total_word_count == -100
        
        # Progress calculation should handle negatives gracefully
        progress = source.get_progress_percentage()
        assert progress >= 0.0  # Should not return negative percentage
    
    def test_very_large_embedding_vectors(self):
        """Test handling of very large embedding vectors."""
        # Test with large vector (like some transformer models)
        large_vector = [float(i * 0.001) for i in range(4096)]
        
        document = Document(
            url="https://example.com",
            chunk_number=0,
            content="test content",
            source_id="test",
            embedding=large_vector
        )
        
        assert len(document.embedding) == 4096
        assert document.embedding[0] == 0.0
        assert document.embedding[-1] == 4.095
    
    def test_empty_string_fields(self):
        """Test handling of empty string fields."""
        # Source with empty strings
        source = Source(
            source_id="test",
            source_type="",
            base_url="",
            title="",
            summary=""
        )
        
        assert source.source_type == ""
        assert source.base_url == ""
        assert source.title == ""
        assert source.summary == ""
    
    def test_special_characters_in_content(self):
        """Test handling of special characters in content fields."""
        special_content = "Hello 世界! 🌍\n\t<script>alert('xss')</script>\x00\xff"
        
        document = Document(
            url="https://example.com",
            chunk_number=0,
            content=special_content,
            source_id="test"
        )
        
        assert document.content == special_content
        assert document.get_char_count() == len(special_content)
    
    def test_model_serialization_with_none_values(self):
        """Test model serialization handles None values correctly."""
        source = Source(
            source_id="test",
            base_url=None,
            title=None,
            summary=None
        )
        
        data = source.model_dump()
        
        assert data["source_id"] == "test"
        assert data["base_url"] is None
        assert data["title"] is None
        assert data["summary"] is None
        assert data["source_type"] == "website"  # default value should still be present
    
    def test_model_serialization_exclude_none(self):
        """Test model serialization with exclude_none option."""
        source = Source(
            source_id="test",
            title="Test Source",
            summary=None  # This should be excluded
        )
        
        data = source.model_dump(exclude_none=True)
        
        assert "source_id" in data
        assert "title" in data
        assert "summary" not in data
        assert "source_type" in data  # default values should still be included
    
    def test_model_validation_edge_cases(self):
        """Test model validation with edge case values."""
        # Zero values
        document = Document(
            url="",  # Empty URL (should be allowed)
            chunk_number=0,
            content="",  # Empty content (should be allowed)
            source_id=""  # Empty source ID (should be allowed)
        )
        
        assert document.url == ""
        assert document.chunk_number == 0
        assert document.content == ""
        assert document.source_id == ""
        
        # Word/char counts should handle empty strings
        assert document.get_char_count() == 0
        assert document.get_word_count() == 0