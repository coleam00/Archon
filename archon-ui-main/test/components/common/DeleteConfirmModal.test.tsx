import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DeleteConfirmModal } from '../../../src/components/common/DeleteConfirmModal';

describe('DeleteConfirmModal', () => {
  const defaultProps = {
    itemName: 'Test Item',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    type: 'task' as const,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders with correct title and message for task type', () => {
    render(<DeleteConfirmModal {...defaultProps} />);
    
    expect(screen.getByText('Delete Task')).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to delete the "Test Item" task/)).toBeInTheDocument();
  });

  it('renders with correct title and message for project type', () => {
    render(<DeleteConfirmModal {...defaultProps} type="project" />);
    
    expect(screen.getByText('Delete Project')).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to delete the "Test Item" project/)).toBeInTheDocument();
  });

  it('renders with correct title and message for client type', () => {
    render(<DeleteConfirmModal {...defaultProps} type="client" />);
    
    expect(screen.getByText('Delete MCP Client')).toBeInTheDocument();
    expect(screen.getByText(/Are you sure you want to delete the "Test Item" client/)).toBeInTheDocument();
  });

  it('calls onConfirm when Delete button is clicked', () => {
    render(<DeleteConfirmModal {...defaultProps} />);
    
    fireEvent.click(screen.getByText('Delete'));
    
    expect(defaultProps.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Cancel button is clicked', () => {
    render(<DeleteConfirmModal {...defaultProps} />);
    
    fireEvent.click(screen.getByText('Cancel'));
    
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when Escape key is pressed', () => {
    render(<DeleteConfirmModal {...defaultProps} />);
    
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when backdrop is clicked', () => {
    render(<DeleteConfirmModal {...defaultProps} />);
    
    // Click the backdrop
    const backdrop = screen.getByTestId('modal-backdrop');
    fireEvent.click(backdrop);
    
    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not call onCancel when modal content is clicked', () => {
    render(<DeleteConfirmModal {...defaultProps} />);
    
    // Click the modal dialog itself
    fireEvent.click(screen.getByRole('dialog'));
    
    expect(defaultProps.onCancel).not.toHaveBeenCalled();
  });

  it('has proper accessibility attributes', () => {
    render(<DeleteConfirmModal {...defaultProps} />);
    
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby');
    expect(dialog).toHaveAttribute('aria-describedby');
  });

  it('focuses Cancel button by default', () => {
    render(<DeleteConfirmModal {...defaultProps} />);
    
    const cancelButton = screen.getByText('Cancel');
    expect(cancelButton).toHaveFocus();
  });

  it('has proper button types', () => {
    render(<DeleteConfirmModal {...defaultProps} />);
    
    const cancelButton = screen.getByText('Cancel');
    const deleteButton = screen.getByText('Delete');
    
    expect(cancelButton).toHaveAttribute('type', 'button');
    expect(deleteButton).toHaveAttribute('type', 'button');
  });
});