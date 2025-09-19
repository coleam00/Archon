from types import SimpleNamespace

import pytest

from src.server.api_routes import knowledge_api


class FakeTracker:
    def __init__(self) -> None:
        self.updates: list[dict] = []
        self.completed: list[dict] = []
        self.errors: list[str] = []

    async def update(self, **kwargs) -> None:
        self.updates.append(kwargs)

    async def complete(self, data: dict) -> None:
        self.completed.append(data)

    async def error(self, message: str) -> None:
        self.errors.append(message)


@pytest.mark.asyncio
async def test_upload_triggers_code_extraction(monkeypatch):
    captured: dict[str, object] = {}

    async def fake_upload_document(
        self,
        file_content: str,
        filename: str,
        source_id: str,
        knowledge_type: str = "documentation",
        tags: list[str] | None = None,
        progress_callback=None,
        cancellation_check=None,
    ):
        captured["upload_file_content"] = file_content
        captured["upload_source_id"] = source_id
        captured["upload_knowledge_type"] = knowledge_type
        captured["upload_tags"] = tags or []

        if progress_callback:
            await progress_callback("Storing document chunks", 65, {"document_batches": 1})

        return True, {"chunks_stored": 3, "source_id": source_id}

    monkeypatch.setattr(
        knowledge_api.DocumentStorageService,
        "upload_document",
        fake_upload_document,
    )

    dummy_client = object()
    monkeypatch.setattr(knowledge_api, "get_supabase_client", lambda: dummy_client)

    events: dict[str, object] = {}

    class StubCodeExtractionService:
        def __init__(self, client):
            events["code_service_client"] = client

        async def extract_and_store_code_examples(
            self,
            crawl_results,
            url_to_full_document,
            source_id,
            progress_callback=None,
            cancellation_check=None,
        ):
            events["code_source_id"] = source_id
            events["code_crawl_results"] = crawl_results
            events["code_url_map"] = url_to_full_document

            if progress_callback:
                await progress_callback(
                    {
                        "progress": 40,
                        "log": "Extracting code blocks",
                        "code_blocks_found": 4,
                    }
                )
                await progress_callback(
                    {
                        "progress": 100,
                        "log": "Stored code examples",
                        "code_examples_stored": 2,
                    }
                )

            return 2

    monkeypatch.setattr(knowledge_api, "CodeExtractionService", StubCodeExtractionService)

    monkeypatch.setattr(
        knowledge_api.uuid,
        "uuid4",
        lambda: SimpleNamespace(hex="deadbeefcafebabe123456789abcdef0"),
    )

    tracker = FakeTracker()

    file_bytes = b"""```python\nprint('hello world')\n```\n"""
    file_metadata = {"filename": "example.md", "content_type": "text/markdown"}

    await knowledge_api._perform_upload_with_progress(
        progress_id="upload-test",
        file_content=file_bytes,
        file_metadata=file_metadata,
        tag_list=["example"],
        knowledge_type="technical",
        extract_code_examples=True,
        tracker=tracker,
    )

    expected_source_id = "file_example_md_deadbeef"
    assert captured["upload_source_id"] == expected_source_id
    assert events["code_source_id"] == expected_source_id

    crawl_results = events["code_crawl_results"]
    assert len(crawl_results) == 1
    assert crawl_results[0]["url"] == "file://example.md"
    assert crawl_results[0]["markdown"].strip().startswith("```python")
    assert crawl_results[0]["title"] == "example.md"

    url_map = events["code_url_map"]
    assert url_map == {"file://example.md": captured["upload_file_content"]}

    assert len(tracker.completed) == 1
    completion_payload = tracker.completed[0]
    assert completion_payload["codeExamplesStored"] == 2
    assert completion_payload["code_examples_stored"] == 2

    assert any(update.get("status") == "code_extraction" for update in tracker.updates)
    assert tracker.errors == []
