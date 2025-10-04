"""
Docling Document Processing Utilities

This module provides advanced document processing capabilities using Docling
for multi-format support, intelligent chunking, and structure preservation.
"""

import io
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from ..config.logfire_config import get_logger, logfire

logger = get_logger(__name__)

# Import Docling with availability check
try:
    from docling import DocumentConverter
    from docling.chunking import HybridChunker
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.document import ConversionResult

    DOCLING_AVAILABLE = True
except ImportError as e:
    logger.warning(f"Docling not available: {e}")
    DOCLING_AVAILABLE = False


class DoclingProcessor:
    """
    Advanced document processor using Docling for multi-format support
    and intelligent chunking optimized for RAG operations.
    """

    def __init__(self):
        """Initialize the Docling processor."""
        if not DOCLING_AVAILABLE:
            raise ImportError(
                "Docling is not available. Please install docling>=1.0.0"
            )
        
        self.converter = DocumentConverter()
        self.chunker = HybridChunker()

    def get_supported_formats(self) -> List[str]:
        """
        Get list of file formats supported by Docling.
        
        Returns:
            List of supported file extensions
        """
        # Based on Docling documentation
        return [
            ".pdf", ".docx", ".pptx", ".xlsx", ".html", ".htm",
            ".mp3", ".wav", ".m4a", ".flac"  # Audio formats (if ASR is configured)
        ]

    def is_supported_format(self, filename: str, content_type: str = None) -> bool:
        """
        Check if a file format is supported by Docling.
        
        Args:
            filename: Name of the file
            content_type: MIME type of the file (optional)
            
        Returns:
            True if format is supported
        """
        if not DOCLING_AVAILABLE:
            return False
            
        file_ext = Path(filename).suffix.lower()
        return file_ext in self.get_supported_formats()

    def detect_input_format(self, filename: str, content_type: str = None) -> Optional[InputFormat]:
        """
        Detect the input format for Docling processing.
        
        Args:
            filename: Name of the file
            content_type: MIME type of the file
            
        Returns:
            InputFormat enum value or None if unsupported
        """
        file_ext = Path(filename).suffix.lower()
        
        format_mapping = {
            ".pdf": InputFormat.PDF,
            ".docx": InputFormat.DOCX,
            ".pptx": InputFormat.PPTX,
            ".xlsx": InputFormat.XLSX,
            ".html": InputFormat.HTML,
            ".htm": InputFormat.HTML,
        }
        
        return format_mapping.get(file_ext)

    def extract_text_and_structure(
        self, 
        file_content: bytes, 
        filename: str, 
        content_type: str = None
    ) -> Tuple[str, Dict[str, Any]]:
        """
        Extract text and structural information from document using Docling.
        
        Args:
            file_content: Raw file bytes
            filename: Name of the file
            content_type: MIME type of the file
            
        Returns:
            Tuple of (extracted_markdown_text, metadata_dict)
            
        Raises:
            ValueError: If the file format is not supported
            Exception: If extraction fails
        """
        if not DOCLING_AVAILABLE:
            raise Exception("Docling is not available")
            
        if not self.is_supported_format(filename, content_type):
            raise ValueError(f"Unsupported file format for Docling: {filename}")

        try:
            # Create temporary file for Docling processing
            with tempfile.NamedTemporaryFile(suffix=Path(filename).suffix, delete=False) as temp_file:
                temp_file.write(file_content)
                temp_path = Path(temp_file.name)

            try:
                # Convert document using Docling
                logfire.info(
                    "Starting Docling document conversion",
                    filename=filename,
                    file_size=len(file_content)
                )
                
                result: ConversionResult = self.converter.convert(temp_path)
                
                # Export to Markdown for RAG-optimized text
                markdown_text = result.document.export_to_markdown()
                
                # Extract metadata
                metadata = {
                    "docling_processed": True,
                    "original_filename": filename,
                    "content_type": content_type,
                    "extraction_method": "docling",
                    "document_structure": {
                        "has_tables": bool(result.document.tables),
                        "has_figures": bool(result.document.figures),
                        "page_count": len(result.document.pages) if result.document.pages else None,
                    }
                }
                
                # Add table information if present
                if result.document.tables:
                    metadata["table_count"] = len(result.document.tables)
                
                # Add figure information if present  
                if result.document.figures:
                    metadata["figure_count"] = len(result.document.figures)

                logfire.info(
                    "Docling document conversion completed",
                    filename=filename,
                    text_length=len(markdown_text),
                    metadata=metadata
                )
                
                return markdown_text, metadata
                
            finally:
                # Clean up temporary file
                try:
                    temp_path.unlink()
                except Exception as cleanup_error:
                    logger.warning(f"Failed to cleanup temp file {temp_path}: {cleanup_error}")

        except Exception as e:
            logfire.error(
                "Docling document extraction failed",
                filename=filename,
                error=str(e),
                exc_info=True
            )
            raise Exception(f"Failed to extract text using Docling from {filename}") from e

    def create_intelligent_chunks(
        self, 
        markdown_text: str, 
        metadata: Dict[str, Any] = None,
        max_tokens: int = 512
    ) -> List[Dict[str, Any]]:
        """
        Create intelligent chunks using Docling's HybridChunker.
        
        Args:
            markdown_text: The markdown text to chunk
            metadata: Document metadata to include in chunks
            max_tokens: Maximum tokens per chunk (default: 512 for embeddings)
            
        Returns:
            List of chunk dictionaries with text and metadata
        """
        if not DOCLING_AVAILABLE:
            raise Exception("Docling is not available")
            
        try:
            # Use Docling's HybridChunker for semantic chunking
            chunks = self.chunker.chunk(markdown_text, max_tokens=max_tokens)
            
            chunk_list = []
            for i, chunk in enumerate(chunks):
                chunk_data = {
                    "text": chunk.text,
                    "chunk_index": i,
                    "chunk_type": "hybrid_semantic",
                    "token_count": len(chunk.text.split()),  # Rough token estimation
                    "metadata": {
                        **(metadata or {}),
                        "chunking_method": "docling_hybrid",
                        "chunk_boundaries": "semantic_aware"
                    }
                }
                chunk_list.append(chunk_data)
            
            logfire.info(
                "Docling intelligent chunking completed",
                original_length=len(markdown_text),
                chunks_created=len(chunk_list),
                max_tokens=max_tokens
            )
            
            return chunk_list
            
        except Exception as e:
            logfire.error(
                "Docling chunking failed",
                error=str(e),
                text_length=len(markdown_text),
                exc_info=True
            )
            # Fallback to simple text chunking
            logger.warning("Falling back to simple chunking due to Docling error")
            return self._fallback_simple_chunks(markdown_text, metadata, max_tokens)

    def _fallback_simple_chunks(
        self, 
        text: str, 
        metadata: Dict[str, Any] = None,
        max_tokens: int = 512
    ) -> List[Dict[str, Any]]:
        """
        Fallback to simple text chunking if Docling chunking fails.
        
        Args:
            text: Text to chunk
            metadata: Metadata to include
            max_tokens: Maximum tokens per chunk
            
        Returns:
            List of simple chunks
        """
        # Simple word-based chunking as fallback
        words = text.split()
        chunk_size = max_tokens * 3  # Rough words-to-tokens ratio
        
        chunks = []
        for i in range(0, len(words), chunk_size):
            chunk_words = words[i:i + chunk_size]
            chunk_text = " ".join(chunk_words)
            
            chunk_data = {
                "text": chunk_text,
                "chunk_index": i // chunk_size,
                "chunk_type": "simple_fallback",
                "token_count": len(chunk_words),
                "metadata": {
                    **(metadata or {}),
                    "chunking_method": "simple_fallback",
                    "chunk_boundaries": "word_based"
                }
            }
            chunks.append(chunk_data)
        
        return chunks

    def process_document_for_rag(
        self, 
        file_content: bytes, 
        filename: str, 
        content_type: str = None,
        max_tokens_per_chunk: int = 512
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        """
        Complete document processing pipeline for RAG operations.
        
        Args:
            file_content: Raw file bytes
            filename: Name of the file  
            content_type: MIME type of the file
            max_tokens_per_chunk: Maximum tokens per chunk for embeddings
            
        Returns:
            Tuple of (chunk_list, document_metadata)
        """
        try:
            # Extract text and structure
            markdown_text, doc_metadata = self.extract_text_and_structure(
                file_content, filename, content_type
            )
            
            # Create intelligent chunks
            chunks = self.create_intelligent_chunks(
                markdown_text, doc_metadata, max_tokens_per_chunk
            )
            
            # Update document metadata
            doc_metadata.update({
                "total_chunks": len(chunks),
                "processing_pipeline": "docling_rag_optimized",
                "chunk_token_limit": max_tokens_per_chunk
            })
            
            logfire.info(
                "Docling RAG processing completed",
                filename=filename,
                total_chunks=len(chunks),
                total_text_length=len(markdown_text)
            )
            
            return chunks, doc_metadata
            
        except Exception as e:
            logfire.error(
                "Docling RAG processing failed",
                filename=filename,
                error=str(e),
                exc_info=True
            )
            raise


# Global processor instance
_docling_processor: Optional[DoclingProcessor] = None


def get_docling_processor() -> DoclingProcessor:
    """
    Get a singleton instance of the Docling processor.
    
    Returns:
        DoclingProcessor instance
        
    Raises:
        ImportError: If Docling is not available
    """
    global _docling_processor
    
    if _docling_processor is None:
        _docling_processor = DoclingProcessor()
    
    return _docling_processor


def is_docling_available() -> bool:
    """
    Check if Docling is available for use.
    
    Returns:
        True if Docling can be imported and used
    """
    return DOCLING_AVAILABLE


def process_document_with_docling(
    file_content: bytes, 
    filename: str, 
    content_type: str = None
) -> Tuple[str, Dict[str, Any]]:
    """
    Convenience function to process a document with Docling.
    
    Args:
        file_content: Raw file bytes
        filename: Name of the file
        content_type: MIME type of the file
        
    Returns:
        Tuple of (extracted_text, metadata)
    """
    processor = get_docling_processor()
    return processor.extract_text_and_structure(file_content, filename, content_type)


def create_rag_chunks_with_docling(
    file_content: bytes, 
    filename: str, 
    content_type: str = None,
    max_tokens: int = 512
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """
    Convenience function to create RAG-optimized chunks with Docling.
    
    Args:
        file_content: Raw file bytes
        filename: Name of the file
        content_type: MIME type of the file
        max_tokens: Maximum tokens per chunk
        
    Returns:
        Tuple of (chunk_list, document_metadata)
    """
    processor = get_docling_processor()
    return processor.process_document_for_rag(file_content, filename, content_type, max_tokens)