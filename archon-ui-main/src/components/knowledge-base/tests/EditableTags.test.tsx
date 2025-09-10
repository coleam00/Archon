import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '../../../features/testing/test-utils';
import { EditableTags } from '../EditableTags';

describe('EditableTags', () => {
  const mockOnTagsUpdate = vi.fn();

  const defaultProps = {
    tags: ['react', 'typescript', 'testing'],
    onTagsUpdate: mockOnTagsUpdate,
    maxVisibleTags: 4,
    isUpdating: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render all tags when count is within maxVisibleTags', () => {
    render(<EditableTags {...defaultProps} />);

    expect(screen.getByText('react')).toBeInTheDocument();
    expect(screen.getByText('typescript')).toBeInTheDocument();
    expect(screen.getByText('testing')).toBeInTheDocument();
  });

  it('should show "Add tags..." button when no tags exist', () => {
    render(<EditableTags {...defaultProps} tags={[]} />);

    expect(screen.getByText('Add tags...')).toBeInTheDocument();
  });

  it('should show add button when tags exist', () => {
    render(<EditableTags {...defaultProps} />);

    const addButton = screen.getByRole('button');
    expect(addButton).toBeInTheDocument();
  });

  it('should enter editing mode when clicking on a tag', async () => {
    render(<EditableTags {...defaultProps} />);

    const reactTag = screen.getByText('react');
    fireEvent.click(reactTag);

    await waitFor(() => {
      const input = screen.getByDisplayValue('react');
      expect(input).toBeInTheDocument();
    });
  });

  it('should save tag changes on blur', async () => {
    render(<EditableTags {...defaultProps} />);

    const reactTag = screen.getByText('react');
    fireEvent.click(reactTag);

    await waitFor(() => {
      const input = screen.getByDisplayValue('react');
      fireEvent.change(input, { target: { value: 'vue' } });
      fireEvent.blur(input);
    });

    await waitFor(() => {
      expect(mockOnTagsUpdate).toHaveBeenCalledWith(['vue', 'typescript', 'testing']);
    });
  });

  it('should save tag changes on Enter key', async () => {
    render(<EditableTags {...defaultProps} />);

    const reactTag = screen.getByText('react');
    fireEvent.click(reactTag);

    await waitFor(() => {
      const input = screen.getByDisplayValue('react');
      fireEvent.change(input, { target: { value: 'angular' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    await waitFor(() => {
      expect(mockOnTagsUpdate).toHaveBeenCalledWith(['angular', 'typescript', 'testing']);
    });
  });

  it('should cancel editing on Escape key', async () => {
    render(<EditableTags {...defaultProps} />);

    const reactTag = screen.getByText('react');
    fireEvent.click(reactTag);

    await waitFor(() => {
      const input = screen.getByDisplayValue('react');
      fireEvent.change(input, { target: { value: 'should-not-save' } });
      fireEvent.keyDown(input, { key: 'Escape' });
    });

    // Should not call onTagsUpdate
    expect(mockOnTagsUpdate).not.toHaveBeenCalled();
    
    // Should show original tag text
    await waitFor(() => {
      expect(screen.getByText('react')).toBeInTheDocument();
    });
  });

  it('should remove tag when clicking remove button', async () => {
    render(<EditableTags {...defaultProps} />);

    const reactTag = screen.getByText('react');
    fireEvent.mouseEnter(reactTag.closest('.group')!);

    await waitFor(() => {
      const removeButton = screen.getByRole('button', { name: /remove/i });
      fireEvent.click(removeButton);
    });

    await waitFor(() => {
      expect(mockOnTagsUpdate).toHaveBeenCalledWith(['typescript', 'testing']);
    });
  });

  it('should add new tag when using add button', async () => {
    render(<EditableTags {...defaultProps} />);

    const addButton = screen.getByRole('button');
    fireEvent.click(addButton);

    await waitFor(() => {
      const input = screen.getByPlaceholderText('New tag');
      fireEvent.change(input, { target: { value: 'newtag' } });
      fireEvent.blur(input);
    });

    await waitFor(() => {
      expect(mockOnTagsUpdate).toHaveBeenCalledWith(['react', 'typescript', 'testing', 'newtag']);
    });
  });

  it('should prevent duplicate tags', async () => {
    render(<EditableTags {...defaultProps} />);

    const addButton = screen.getByRole('button');
    fireEvent.click(addButton);

    await waitFor(() => {
      const input = screen.getByPlaceholderText('New tag');
      fireEvent.change(input, { target: { value: 'react' } }); // Duplicate tag
      fireEvent.blur(input);
    });

    // Should not call onTagsUpdate for duplicate
    expect(mockOnTagsUpdate).not.toHaveBeenCalled();
  });

  it('should trim whitespace and reject empty tags', async () => {
    render(<EditableTags {...defaultProps} />);

    const addButton = screen.getByRole('button');
    fireEvent.click(addButton);

    await waitFor(() => {
      const input = screen.getByPlaceholderText('New tag');
      fireEvent.change(input, { target: { value: '   ' } }); // Only whitespace
      fireEvent.blur(input);
    });

    // Should not call onTagsUpdate for empty tag
    expect(mockOnTagsUpdate).not.toHaveBeenCalled();
  });

  it('should handle long tags correctly', async () => {
    render(<EditableTags {...defaultProps} />);

    const addButton = screen.getByRole('button');
    fireEvent.click(addButton);

    const longTag = 'a'.repeat(60); // Exceeds 50 char limit

    await waitFor(() => {
      const input = screen.getByPlaceholderText('New tag');
      fireEvent.change(input, { target: { value: longTag } });
      fireEvent.blur(input);
    });

    // Should not call onTagsUpdate for tag exceeding length limit
    expect(mockOnTagsUpdate).not.toHaveBeenCalled();
  });

  it('should show more tags tooltip when exceeding maxVisibleTags', () => {
    const manyTags = ['tag1', 'tag2', 'tag3', 'tag4', 'tag5', 'tag6'];
    render(<EditableTags {...defaultProps} tags={manyTags} maxVisibleTags={3} />);

    expect(screen.getByText('+3 more...')).toBeInTheDocument();
  });

  it('should disable editing when isUpdating is true', () => {
    render(<EditableTags {...defaultProps} isUpdating={true} />);

    const reactTag = screen.getByText('react');
    fireEvent.click(reactTag);

    // Should not enter editing mode
    expect(screen.queryByDisplayValue('react')).not.toBeInTheDocument();
  });

  it('should handle remove tag during editing', async () => {
    render(<EditableTags {...defaultProps} />);

    const reactTag = screen.getByText('react');
    fireEvent.click(reactTag);

    await waitFor(() => {
      const input = screen.getByDisplayValue('react');
      fireEvent.change(input, { target: { value: '' } }); // Clear the tag
      fireEvent.blur(input);
    });

    await waitFor(() => {
      expect(mockOnTagsUpdate).toHaveBeenCalledWith(['typescript', 'testing']);
    });
  });

  it('should add new tag with Enter key', async () => {
    render(<EditableTags {...defaultProps} />);

    const addButton = screen.getByRole('button');
    fireEvent.click(addButton);

    await waitFor(() => {
      const input = screen.getByPlaceholderText('New tag');
      fireEvent.change(input, { target: { value: 'newtag' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    await waitFor(() => {
      expect(mockOnTagsUpdate).toHaveBeenCalledWith(['react', 'typescript', 'testing', 'newtag']);
    });
  });

  it('should handle valid trimmed tag addition', async () => {
    render(<EditableTags {...defaultProps} />);

    const addButton = screen.getByRole('button');
    fireEvent.click(addButton);

    await waitFor(() => {
      const input = screen.getByPlaceholderText('New tag');
      fireEvent.change(input, { target: { value: '  validtag  ' } }); // With whitespace
      fireEvent.blur(input);
    });

    await waitFor(() => {
      expect(mockOnTagsUpdate).toHaveBeenCalledWith(['react', 'typescript', 'testing', 'validtag']);
    });
  });
});