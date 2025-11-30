"""
Storage Services

This module contains all storage service classes that handle document and data storage operations.
These services extend the base storage functionality with specific implementations.
"""

from typing import Any

from ...config.logfire_config import get_logger, safe_span
from .base_storage_service import BaseStorageService
from .document_storage_service import add_documents_to_supabase

logger = get_logger(__name__)


class DocumentStorageService(BaseStorageService):
    """Service for handling document uploads with progress reporting."""

    async def upload_document(
        self,
        file_content: str,
        filename: str,
        source_id: str,
        knowledge_type: str = "documentation",
        tags: list[str] | None = None,
        extract_code_examples: bool = True,
        progress_callback: Any | None = None,
        cancellation_check: Any | None = None,
    ) -> tuple[bool, dict[str, Any]]:
        """
        Upload and process a document file with progress reporting.

        Args:
            file_content: Document content as text
            filename: Name of the file
            source_id: Source identifier
            knowledge_type: Type of knowledge
            tags: Optional list of tags
            extract_code_examples: Whether to extract code examples from the document
            progress_callback: Optional callback for progress
            cancellation_check: Optional function to check for cancellation

        Returns:
            Tuple of (success, result_dict)
        """
        logger.info(f"Document upload starting: {filename} as {knowledge_type} knowledge")

        with safe_span(
            "upload_document",
            filename=filename,
            source_id=source_id,
            content_length=len(file_content),
        ) as span:
            try:
                # Progress reporting helper
                async def report_progress(message: str, percentage: int, batch_info: dict = None):
                    if progress_callback:
                        await progress_callback(message, percentage, batch_info)

                await report_progress("Starting document processing...", 10)

                # Use base class chunking
                chunks = await self.smart_chunk_text_async(
                    file_content,
                    chunk_size=5000,
                    progress_callback=lambda msg, pct: report_progress(
                        f"Chunking: {msg}", 10 + float(pct) * 0.2
                    ),
                )

                if not chunks:
                    raise ValueError(f"No content could be extracted from {filename}. The file may be empty, corrupted, or in an unsupported format.")

                await report_progress("Preparing document chunks...", 30)

                # Prepare data for storage
                doc_url = f"file://{filename}"
                urls = []
                chunk_numbers = []
                contents = []
                metadatas = []
                total_word_count = 0

                # Process chunks with metadata
                for i, chunk in enumerate(chunks):
                    # Use base class metadata extraction
                    meta = self.extract_metadata(
                        chunk,
                        {
                            "chunk_index": i,
                            "url": doc_url,
                            "source": source_id,
                            "source_id": source_id,
                            "knowledge_type": knowledge_type,
                            "source_type": "file",  # FIX: Mark as file upload
                            "filename": filename,
                        },
                    )

                    if tags:
                        meta["tags"] = tags

                    urls.append(doc_url)
                    chunk_numbers.append(i)
                    contents.append(chunk)
                    metadatas.append(meta)
                    total_word_count += meta.get("word_count", 0)

                await report_progress("Updating source information...", 50)

                # Create URL to full document mapping
                url_to_full_document = {doc_url: file_content}

                # Update source information
                from ..source_management_service import extract_source_summary, update_source_info

                source_summary = await extract_source_summary(source_id, file_content[:5000])

                logger.info(f"Updating source info for {source_id} with knowledge_type={knowledge_type}")
                await update_source_info(
                    self.supabase_client,
                    source_id,
                    source_summary,
                    total_word_count,
                    content=file_content[:1000],  # content for title generation
                    knowledge_type=knowledge_type,
                    tags=tags,
                    source_url=f"file://{filename}",
                    source_display_name=filename,
                    source_type="file",  # Mark as file upload
                )

                await report_progress("Storing document chunks...", 70)

                # Store documents
                await add_documents_to_supabase(
                    client=self.supabase_client,
                    urls=urls,
                    chunk_numbers=chunk_numbers,
                    contents=contents,
                    metadatas=metadatas,
                    url_to_full_document=url_to_full_document,
                    batch_size=15,
                    progress_callback=progress_callback,
                    enable_parallel_batches=True,
                    provider=None,  # Use configured provider
                    cancellation_check=cancellation_check,
                )

                # Extract code examples if requested
                code_examples_count = 0
                if extract_code_examples and len(chunks) > 0:
                    try:
                        await report_progress("Extracting code examples...", 85)
                        
                        logger.info(f"🔍 DEBUG: Starting code extraction for {filename} | extract_code_examples={extract_code_examples}")
                        
                        # Import code extraction service
                        from ..crawling.code_extraction_service import CodeExtractionService
                        
                        code_service = CodeExtractionService(self.supabase_client)
                        
                        # Create crawl_results format expected by code extraction service
                        # markdown: cleaned plaintext (HTML->markdown for HTML files, raw content otherwise)
                        # html: empty string to prevent HTML extraction path confusion
                        # content_type: proper type to guide extraction method selection
                        crawl_results = [{
                            "url": doc_url,
                            "markdown": file_content,  # Cleaned plaintext/markdown content
                            "html": "",  # Empty to prevent HTML extraction path
                            "content_type": "application/pdf" if filename.lower().endswith('.pdf') else (
                                "text/markdown" if filename.lower().endswith(('.html', '.htm', '.md')) else "text/plain"
                            )
                        }]
                        
                        logger.info(f"🔍 DEBUG: Created crawl_results with url={doc_url}, content_length={len(file_content)}")
                        
                        # Create progress callback for code extraction
                        async def code_progress_callback(data: dict):
                            logger.info(f"🔍 DEBUG: Code extraction progress: {data}")
                            if progress_callback:
                                # Map code extraction progress (0-100) to our remaining range (85-95)
                                raw_progress = data.get("progress", data.get("percentage", 0))
                                mapped_progress = 85 + (raw_progress / 100.0) * 10  # 85% to 95%
                                message = data.get("log", "Extracting code examples...")
                                await progress_callback(message, int(mapped_progress))
                        
                        logger.info(f"🔍 DEBUG: About to call extract_and_store_code_examples...")
                        code_examples_count = await code_service.extract_and_store_code_examples(
                            crawl_results=crawl_results,
                            url_to_full_document=url_to_full_document,
                            source_id=source_id,
                            progress_callback=code_progress_callback,
                            cancellation_check=cancellation_check,
                        )
                        
                        logger.info(f"🔍 DEBUG: Code extraction completed: {code_examples_count} code examples found for {filename}")
                        
                    except Exception as e:
                        # Log error with full traceback but don't fail the entire upload
                        logger.error(f"Code extraction failed for {filename}: {e}", exc_info=True)
                        code_examples_count = 0
                
                await report_progress("Document upload completed!", 100)

                result = {
                    "chunks_stored": len(chunks),
                    "code_examples_stored": code_examples_count,
                    "total_word_count": total_word_count,
                    "source_id": source_id,
                    "filename": filename,
                }

                span.set_attribute("success", True)
                span.set_attribute("chunks_stored", len(chunks))
                span.set_attribute("code_examples_stored", code_examples_count)
                span.set_attribute("total_word_count", total_word_count)

                logger.info(
                    f"Document upload completed successfully: filename={filename}, chunks_stored={len(chunks)}, code_examples_stored={code_examples_count}, total_word_count={total_word_count}"
                )

                return True, result

            except Exception as e:
                span.set_attribute("success", False)
                span.set_attribute("error", str(e))
                logger.error(f"Error uploading document: {e}")

                # Error will be handled by caller

                return False, {"error": f"Error uploading document: {str(e)}"}

    async def store_documents(self, documents: list[dict[str, Any]], **kwargs) -> dict[str, Any]:
        """
        Store multiple documents. Implementation of abstract method.

        Args:
            documents: List of documents to store
            **kwargs: Additional options (progress_callback, etc.)

        Returns:
            Storage result
        """
        results = []
        for doc in documents:
            success, result = await self.upload_document(
                file_content=doc["content"],
                filename=doc["filename"],
                source_id=doc.get("source_id", "upload"),
                knowledge_type=doc.get("knowledge_type", "documentation"),
                tags=doc.get("tags"),
                extract_code_examples=doc.get("extract_code_examples", True),
                progress_callback=kwargs.get("progress_callback"),
                cancellation_check=kwargs.get("cancellation_check"),
            )
            results.append(result)

        return {
            "success": all(r.get("chunks_stored", 0) > 0 for r in results),
            "documents_processed": len(documents),
            "results": results,
        }

    async def process_document(self, document: dict[str, Any], **kwargs) -> dict[str, Any]:
        """
        Process a single document. Implementation of abstract method.

        Args:
            document: Document to process
            **kwargs: Additional processing options

        Returns:
            Processed document with metadata
        """
        # Extract text content
        content = document.get("content", "")

        # Chunk the content
        chunks = await self.smart_chunk_text_async(content)

        # Extract metadata for each chunk
        processed_chunks = []
        for i, chunk in enumerate(chunks):
            meta = self.extract_metadata(
                chunk, {"chunk_index": i, "source": document.get("source", "unknown")}
            )
            processed_chunks.append({"content": chunk, "metadata": meta})

        return {
            "chunks": processed_chunks,
            "total_chunks": len(chunks),
            "source": document.get("source"),
        }

    def store_code_examples(
        self, code_examples: list[dict[str, Any]]
    ) -> tuple[bool, dict[str, Any]]:
        """
        Store code examples. This is kept for backward compatibility.
        The actual implementation should use add_code_examples_to_supabase directly.

        Args:
            code_examples: List of code examples

        Returns:
            Tuple of (success, result)
        """
        try:
            if not code_examples:
                return True, {"code_examples_stored": 0}

            # This method exists for backward compatibility
            # The actual storage should be done through the proper service functions
            logger.warning(
                "store_code_examples is deprecated. Use add_code_examples_to_supabase directly."
            )

            return True, {"code_examples_stored": len(code_examples)}

        except Exception as e:
            logger.error(f"Error in store_code_examples: {e}")
            return False, {"error": str(e)}

    async def upload_document_with_enhanced_chunking(
        self,
        file_content: bytes,
        filename: str,
        content_type: str,
        source_id: str,
        knowledge_type: str = "documentation",
        tags: list[str] | None = None,
        extract_code_examples: bool = True,
        progress_callback: Any | None = None,
        cancellation_check: Any | None = None,
        max_tokens_per_chunk: int = 512,
    ) -> tuple[bool, dict[str, Any]]:
        """
        Upload and process a document using enhanced Docling chunking.
        
        This method uses Docling's intelligent chunking when available,
        falling back to legacy processing for unsupported formats.

        Args:
            file_content: Raw document bytes  
            filename: Name of the file
            content_type: MIME type of the file
            source_id: Source identifier
            knowledge_type: Type of knowledge
            tags: Optional list of tags
            extract_code_examples: Whether to extract code examples
            progress_callback: Optional callback for progress
            cancellation_check: Optional function to check for cancellation
            max_tokens_per_chunk: Maximum tokens per chunk for embeddings

        Returns:
            Tuple of (success, result_dict)
        """
        from ...utils.document_processing import extract_and_chunk_for_rag
        
        logger.info(f"Enhanced document upload starting: {filename} as {knowledge_type} knowledge")

        with safe_span(
            "upload_document_enhanced",
            filename=filename,
            source_id=source_id,
            content_length=len(file_content),
            use_docling=True,
        ) as span:
            try:
                # Progress reporting helper
                async def report_progress(message: str, percentage: int, batch_info: dict = None):
                    if progress_callback:
                        await progress_callback(message, percentage, batch_info)

                await report_progress("Starting enhanced document processing...", 10)

                # Use enhanced extraction and chunking with Docling
                full_text, docling_chunks, doc_metadata = extract_and_chunk_for_rag(
                    file_content, filename, content_type, max_tokens_per_chunk
                )

                if not docling_chunks:
                    raise ValueError(f"No content could be extracted from {filename}. The file may be empty, corrupted, or in an unsupported format.")

                logger.info(
                    f"Enhanced processing completed for {filename}: "
                    f"{len(docling_chunks)} chunks created with {doc_metadata.get('extraction_method', 'unknown')} method"
                )

                await report_progress("Preparing enhanced document chunks...", 30)

                # Prepare data for storage using Docling chunks
                doc_url = f"file://{filename}"
                urls = []
                chunk_numbers = []
                contents = []
                metadatas = []
                total_word_count = 0

                # Process Docling chunks with enhanced metadata
                for i, chunk in enumerate(docling_chunks):
                    chunk_text = chunk["text"]
                    chunk_metadata = chunk.get("metadata", {})
                    
                    # Combine base metadata with Docling metadata
                    enhanced_meta = {
                        "chunk_index": i,
                        "url": doc_url,
                        "source": source_id,
                        "source_id": source_id,
                        "knowledge_type": knowledge_type,
                        "source_type": "file",
                        "filename": filename,
                        # Add Docling-specific metadata
                        "docling_processed": doc_metadata.get("docling_processed", False),
                        "chunking_method": chunk_metadata.get("chunking_method", "unknown"),
                        "chunk_type": chunk.get("chunk_type", "unknown"),
                        "estimated_tokens": chunk.get("token_count", 0),
                        "extraction_method": doc_metadata.get("extraction_method", "legacy"),
                    }
                    
                    # Add document-level metadata to first chunk
                    if i == 0:
                        enhanced_meta.update({
                            "document_metadata": doc_metadata,
                            "total_chunks": len(docling_chunks),
                        })
                    
                    # Add tags if provided
                    if tags:
                        enhanced_meta["tags"] = tags

                    urls.append(doc_url)
                    chunk_numbers.append(i)
                    contents.append(chunk_text)
                    metadatas.append(enhanced_meta)
                    total_word_count += len(chunk_text.split())

                await report_progress(f"Processing {len(docling_chunks)} enhanced chunks...", 40)

                # Store documents using existing document storage
                url_to_full_document = {doc_url: full_text}
                storage_result = await add_documents_to_supabase(
                    self.supabase_client,
                    urls,
                    chunk_numbers,
                    contents,
                    metadatas,
                    url_to_full_document,
                    progress_callback=lambda stage, progress, message, **kwargs: report_progress(
                        f"Storing: {message}", 40 + (progress * 0.5)
                    ),
                    cancellation_check=cancellation_check,
                )

                chunks_stored = storage_result.get("chunks_stored", 0)

                await report_progress("Finalizing enhanced document upload...", 90)

                # Extract code examples if requested
                code_examples_count = 0
                if extract_code_examples and len(docling_chunks) > 0:
                    try:
                        await report_progress("Extracting code examples...", 95)
                        
                        logger.info(f"🔍 DEBUG: Starting code extraction for {filename} (enhanced) | extract_code_examples={extract_code_examples}")
                        
                        # Import code extraction service
                        from ..crawling.code_extraction_service import CodeExtractionService
                        
                        code_service = CodeExtractionService(self.supabase_client)
                        
                        # Create crawl_results format with enhanced metadata
                        crawl_results = [{
                            "url": doc_url,
                            "markdown": full_text,  # Use full extracted text
                            "html": "",  # Empty to prevent HTML extraction path
                            "content_type": content_type,
                            "docling_processed": doc_metadata.get("docling_processed", False),
                            "extraction_method": doc_metadata.get("extraction_method", "legacy"),
                        }]
                        
                        logger.info(f"🔍 DEBUG: Created enhanced crawl_results with url={doc_url}, content_length={len(full_text)}")
                        
                        # Create progress callback for code extraction
                        async def code_progress_callback(data: dict):
                            if progress_callback:
                                raw_progress = data.get("progress", data.get("percentage", 0))
                                mapped_progress = 95 + (raw_progress / 100.0) * 5  # 95% to 100%
                                message = data.get("log", "Extracting code examples...")
                                await progress_callback(message, int(mapped_progress))
                        
                        code_examples_count = await code_service.extract_and_store_code_examples(
                            crawl_results=crawl_results,
                            url_to_full_document=url_to_full_document,
                            source_id=source_id,
                            progress_callback=code_progress_callback,
                            cancellation_check=cancellation_check,
                        )
                        
                        logger.info(f"🔍 DEBUG: Enhanced code extraction completed: {code_examples_count} code examples found for {filename}")
                        
                    except Exception as e:
                        logger.error(f"Code extraction failed for {filename}: {e}", exc_info=True)
                        code_examples_count = 0

                await report_progress("Enhanced document upload completed!", 100)

                result_dict = {
                    "source_id": source_id,
                    "filename": filename,
                    "chunks_stored": chunks_stored,
                    "code_examples_stored": code_examples_count,
                    "total_word_count": total_word_count,
                    "processing_method": "docling_enhanced" if doc_metadata.get("docling_processed") else "legacy_fallback",
                    "extraction_method": doc_metadata.get("extraction_method", "legacy"),
                    "chunking_method": doc_metadata.get("chunking_method", "unknown"),
                    "document_metadata": doc_metadata,
                }

                span.set_attribute("success", True)
                span.set_attribute("chunks_stored", chunks_stored)
                span.set_attribute("code_examples_stored", code_examples_count)
                span.set_attribute("processing_method", result_dict["processing_method"])

                logger.info(f"Enhanced document upload completed successfully: {filename}")
                return True, result_dict

            except Exception as e:
                logger.error(f"Enhanced document upload failed: {filename}", exc_info=True)
                span.set_attribute("success", False)
                span.set_attribute("error", str(e))
                return False, {"error": str(e), "filename": filename}
