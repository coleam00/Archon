"""
Storage Services

This module contains all storage service classes that handle document and data storage operations.
These services extend the base storage functionality with specific implementations.
"""

import os
import ntpath
import inspect
from urllib.parse import quote
from typing import Any

from fastapi import WebSocket

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
        websocket: WebSocket | None = None,
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
            websocket: Optional WebSocket for progress
            progress_callback: Optional callback for progress

        Returns:
            Tuple of (success, result_dict)
        """
        # Strip any path traversal (handle both POSIX and Windows separators)
        # Strip any path traversal (handle both POSIX and Windows separators)
        candidate = os.path.basename(filename)
        safe_filename = ntpath.basename(candidate) or candidate

        # Comprehensive validation
        if (not safe_filename or
            safe_filename.startswith('.') or
            '..' in safe_filename or
            safe_filename.strip() == '' or
            len(safe_filename) > 255 or
            any(c in safe_filename for c in ['/', '\\', '\0', ':', '*', '?', '"', '<', '>', '|'])):
            return False, {"error": "Invalid filename", "filename": safe_filename, "source_id": source_id}
        
        logger.info(f"Document upload starting: {safe_filename} as {knowledge_type} knowledge")
        
        with safe_span(
            "upload_document",
            filename=safe_filename,
            source_id=source_id,
            content_length=len(file_content),
        ) as span:
            try:
                # Progress reporting helper
                async def report_progress(message: str, percentage: float, batch_info: dict | None = None):
                    # Normalize, clamp, and convert to int for UI
                    try:
                        progress_value = int(round(min(max(percentage, 0.0), 100.0)))
                    except Exception:
                        progress_value = 0

                    if websocket:
                        try:
                            data = {
                                "type": "upload_progress",
                                "filename": safe_filename,
                                "progress": progress_value,
                                "message": message,
                            }
                            if batch_info:
                                data.update(batch_info)
                            await websocket.send_json(data)
                        except Exception as ws_err:
                            logger.warning(
                                f"WebSocket progress send failed: {ws_err} | filename={safe_filename} | source_id={source_id}",
                                exc_info=True,
                            )
                    if progress_callback:
                        try:
                            res = progress_callback(message, progress_value, batch_info)
                            # Support both sync and async callbacks
                            if inspect.isawaitable(res):
                                await res
                        except Exception as cb_err:
                            logger.warning(
                                f"Progress callback failed: {cb_err} | filename={safe_filename} | source_id={source_id}",
                                exc_info=True,
                            )

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
                    raise ValueError("No content could be extracted from the document")

                await report_progress("Preparing document chunks...", 30)

                # Prepare data for storage
                doc_url = f"file://{quote(safe_filename)}"
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
                            "filename": safe_filename,
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
                from ..credential_service import credential_service

                # Get the active LLM provider for summary generation
                try:
                    provider_config = await credential_service.get_active_provider("llm")
                    active_provider = provider_config.get("provider", "openai")
                except Exception as e:
                    logger.warning(
                        f"Failed to get active provider for file upload, falling back to OpenAI: {e} | "
                        f"filename={safe_filename} | source_id={source_id}"
                    )
                    active_provider = "openai"

                # Trace: record which LLM provider was used
                try:
                    span.set_attribute("active_provider", active_provider)
                except Exception:
                    pass

                # Get the active embedding provider for document embeddings
                try:
                    embedding_provider_config = await credential_service.get_active_provider("embedding")
                    active_embedding_provider = embedding_provider_config.get("provider", "openai")
                    # OpenRouter does not support embeddings—force OpenAI here
                    if active_embedding_provider.lower() == "openrouter":
                        logger.warning(
                            "Embedding provider 'openrouter' not supported for embeddings, falling back to OpenAI | "
                            f"filename={safe_filename} | source_id={source_id}"
                        )
                        active_embedding_provider = "openai"
                    logger.info(
                        f"Using embedding provider '{active_embedding_provider}' for file upload embeddings | "
                        f"filename={safe_filename} | source_id={source_id}"
                    )
                except Exception as e:
                    logger.warning(
                        f"Failed to get active embedding provider for file upload, falling back to OpenAI: {e} | "
                        f"filename={safe_filename} | source_id={source_id}"
                    )
                    active_embedding_provider = "openai"

                # Trace: record which embedding provider was used
                try:
                    span.set_attribute("active_embedding_provider", active_embedding_provider)
                except Exception:
                    pass

                # Build a representative sample across the document to avoid intro bias (5k total)
                summary_sample = (
                    file_content[:1700]
                    + "\n...\n"
                    + file_content[max(len(file_content) // 2 - 850, 0) : (len(file_content) // 2 + 850)]
                    + "\n...\n"
                    + file_content[-1600:]
                ) if len(file_content) > 5000 else file_content[:5000]

                source_summary = await extract_source_summary(
                    source_id,
                    summary_sample,
                    500,
                    active_provider,
                )

                logger.info(f"Updating source info for {source_id} with knowledge_type={knowledge_type}")
                await update_source_info(
                    client=self.supabase_client,
                    source_id=source_id,
                    summary=source_summary,
                    word_count=total_word_count,
                    content=file_content[:1000],
                    knowledge_type=knowledge_type,
                    tags=tags,
                    original_url=doc_url,
                    provider=active_provider,
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
                    provider=active_embedding_provider,  # Use configured embedding provider
                    cancellation_check=cancellation_check,
                )

                await report_progress("Document upload completed!", 100)

                result = {
                    "chunks_stored": len(chunks),
                    "total_word_count": total_word_count,
                    "source_id": source_id,
                    "filename": safe_filename,
                }

                span.set_attribute("success", True)
                span.set_attribute("chunks_stored", len(chunks))
                span.set_attribute("total_word_count", total_word_count)

                logger.info(
                    f"Document upload completed successfully: filename={safe_filename}, chunks_stored={len(chunks)}, total_word_count={total_word_count}"
                )

                return True, result

            except Exception as e:
                span.set_attribute("success", False)
                span.set_attribute("error", str(e))
                logger.error(
                    f"Error uploading document: {e} | filename={safe_filename} | source_id={source_id}",
                    exc_info=True,
                )

                if websocket:
                    try:
                        await websocket.send_json({
                            "type": "upload_error",
                            "error": str(e),
                            "filename": safe_filename,
                            "source_id": source_id,
                        })
                    except Exception as ws_err:
                        logger.warning(
                            f"WebSocket error-notify failed: {ws_err} | filename={safe_filename} | source_id={source_id}",
                            exc_info=True,
                        )

                return False, {
                    "error": f"Error uploading document: {str(e)}",
                    "filename": safe_filename,
                    "source_id": source_id,
                }

    async def store_documents(self, documents: list[dict[str, Any]], **kwargs) -> dict[str, Any]:
        """
        Store multiple documents. Implementation of abstract method.

        Args:
            documents: List of documents to store
            **kwargs: Additional options (websocket, progress_callback, etc.)

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
                websocket=kwargs.get("websocket"),
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
