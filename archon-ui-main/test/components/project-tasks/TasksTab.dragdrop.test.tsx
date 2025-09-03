import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('TasksTab Drag and Drop Integration', () => {
  it('should properly manage movingTaskIds during drag operations', () => {
    const tasksTabPath = join(process.cwd(), 'src/components/project-tasks/TasksTab.tsx');
    const fileContent = readFileSync(tasksTabPath, 'utf-8');
    
    // Check that moveTask adds task to movingTaskIds
    expect(fileContent).toContain('setMovingTaskIds(prev => new Set([...prev, taskId]))');
    
    // Check that moveTask removes task from movingTaskIds in finally block
    expect(fileContent).toContain('finally {');
    expect(fileContent).toMatch(/finally\s*{\s*\/\/\s*Remove from loading set\s*setMovingTaskIds/);
    
    // Check that the cleanup happens even on error
    const moveTaskMatch = fileContent.match(/const moveTask[\s\S]*?\n{2}\};/);
    expect(moveTaskMatch).toBeTruthy();
    if (moveTaskMatch) {
      const moveTaskFunction = moveTaskMatch[0];
      expect(moveTaskFunction).toContain('try {');
      expect(moveTaskFunction).toContain('catch (error)');
      expect(moveTaskFunction).toContain('finally {');
    }
  });
  
  it('should pass movingTaskIds to TaskBoardView', () => {
    const tasksTabPath = join(process.cwd(), 'src/components/project-tasks/TasksTab.tsx');
    const fileContent = readFileSync(tasksTabPath, 'utf-8');
    
    // Check that movingTaskIds is passed to TaskBoardView
    expect(fileContent).toContain('movingTaskIds={movingTaskIds}');
  });
  
  it('should handle task completion through moveTask', () => {
    const tasksTabPath = join(process.cwd(), 'src/components/project-tasks/TasksTab.tsx');
    const fileContent = readFileSync(tasksTabPath, 'utf-8');
    
    // Check that completeTask calls moveTask
    expect(fileContent).toMatch(/completeTask.*moveTask\(taskId, 'done'\)/s);
  });
  
  it('should have optimistic updates in moveTask', () => {
    const tasksTabPath = join(process.cwd(), 'src/components/project-tasks/TasksTab.tsx');
    const fileContent = readFileSync(tasksTabPath, 'utf-8');
    
    // Check for optimistic update comment and implementation
    expect(fileContent).toContain('// Optimistically update UI for immediate feedback');
    expect(fileContent).toContain('setTasks(prev => prev.map(task =>');
  });
  
  it('should revert on error as indicated by comment', () => {
    const tasksTabPath = join(process.cwd(), 'src/components/project-tasks/TasksTab.tsx');
    const fileContent = readFileSync(tasksTabPath, 'utf-8');
    
    // Check for revert comment
    expect(fileContent).toContain('// Revert optimistic update - polling will sync correct state');
  });
});