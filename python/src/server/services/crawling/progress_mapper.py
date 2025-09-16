"""
Progress Mapper for Background Tasks

Maps sub-task progress (0-100%) to overall task progress ranges.
This ensures smooth progress reporting without jumping backwards.
"""


class ProgressMapper:
    """Maps sub-task progress to overall progress ranges"""

    # Define progress ranges for each stage
    # Reflects actual processing time distribution
    STAGE_RANGES = {
        # Common stages
        "starting": (0, 1),
        "initializing": (0, 1),
        "error": (-1, -1),            # Special case for errors
        "cancelled": (-1, -1),        # Special case for cancellation
        "completed": (100, 100),

        # Crawl-specific stages - rebalanced based on actual time taken
        "analyzing": (1, 3),          # URL analysis is quick
        "crawling": (3, 15),          # Crawling can take time for deep/many URLs
        "processing": (15, 20),       # Content processing/chunking
        "source_creation": (20, 25),  # DB operations
        "document_storage": (25, 40), # Embeddings generation takes significant time
        "code_extraction": (40, 90),  # Code extraction + summaries - still longest but more balanced
        "finalization": (90, 100),    # Final steps and cleanup

        # Upload-specific stages
        "reading": (0, 5),
        "text_extraction": (5, 10),   # Clear name for text extraction from files
        "chunking": (10, 15),
        # Note: source_creation is defined above at (20, 25) for all operations
        "summarizing": (25, 35),
        "storing": (35, 100),
    }

    def __init__(self):
        """Initialize the progress mapper"""
        self.last_overall_progress = 0
        self.current_stage = "starting"

    def map_progress(self, stage: str, stage_progress: float) -> int:
        """
        Map stage-specific progress to overall progress.

        Args:
            stage: The current stage name
            stage_progress: Progress within the stage (0-100)

        Returns:
            Overall progress percentage (0-100)
        """
        # Handle error and cancelled states - preserve last known progress
        if stage in ("error", "cancelled"):
            return self.last_overall_progress

        # Get stage range
        if stage not in self.STAGE_RANGES:
            # Unknown stage - use current progress
            return self.last_overall_progress

        start, end = self.STAGE_RANGES[stage]

        # Handle completion
        if stage == "completed":
            self.last_overall_progress = 100
            return 100

        # Calculate mapped progress
        stage_progress = max(0, min(100, stage_progress))  # Clamp to 0-100
        stage_range = end - start
        mapped_progress = start + (stage_progress / 100.0) * stage_range

        # Debug logging for document_storage
        if stage == "document_storage" and stage_progress >= 90:
            import logging
            logger = logging.getLogger(__name__)
            logger.info(
                f"DEBUG: ProgressMapper.map_progress | stage={stage} | stage_progress={stage_progress}% | "
                f"range=({start}, {end}) | mapped_before_check={mapped_progress:.1f}% | "
                f"last_overall={self.last_overall_progress}%"
            )

        # Ensure progress never goes backwards
        mapped_progress = max(self.last_overall_progress, mapped_progress)

        # Round to integer
        overall_progress = int(round(mapped_progress))

        # Update state
        self.last_overall_progress = overall_progress
        self.current_stage = stage

        return overall_progress

    def get_stage_range(self, stage: str) -> tuple:
        """Get the progress range for a stage"""
        return self.STAGE_RANGES.get(stage, (0, 100))

    def calculate_stage_progress(self, current_value: int, max_value: int) -> float:
        """
        Calculate percentage progress within a stage.

        Args:
            current_value: Current progress value (e.g., processed items)
            max_value: Maximum value (e.g., total items)

        Returns:
            Progress percentage within stage (0-100)
        """
        if max_value <= 0:
            return 0.0

        return (current_value / max_value) * 100.0

    def map_batch_progress(self, stage: str, current_batch: int, total_batches: int) -> int:
        """
        Convenience method for mapping batch processing progress.

        Args:
            stage: The current stage name
            current_batch: Current batch number (1-based)
            total_batches: Total number of batches

        Returns:
            Overall progress percentage
        """
        if total_batches <= 0:
            return self.last_overall_progress

        # Calculate stage progress (0-based for calculation)
        stage_progress = ((current_batch - 1) / total_batches) * 100.0

        return self.map_progress(stage, stage_progress)

    def map_with_substage(self, stage: str, substage: str, stage_progress: float) -> int:
        """
        Map progress with substage information for finer control.

        Args:
            stage: Main stage (e.g., 'document_storage')
            substage: Substage (e.g., 'embeddings', 'chunking')
            stage_progress: Progress within the stage

        Returns:
            Overall progress percentage
        """
        # For now, just use the main stage
        # Could be extended to support substage ranges
        return self.map_progress(stage, stage_progress)

    def reset(self):
        """Reset the mapper to initial state"""
        self.last_overall_progress = 0
        self.current_stage = "starting"

    def get_current_stage(self) -> str:
        """Get the current stage name"""
        return self.current_stage

    def get_current_progress(self) -> int:
        """Get the current overall progress percentage"""
        return self.last_overall_progress
