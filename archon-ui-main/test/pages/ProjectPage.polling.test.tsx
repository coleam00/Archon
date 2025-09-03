import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('ProjectPage Polling Conflict Prevention', () => {
  it('should have movingTaskIds check in polling useEffect', () => {
    // Read the actual source file to verify the implementation
    const projectPagePath = join(process.cwd(), 'src/pages/ProjectPage.tsx');
    const fileContent = readFileSync(projectPagePath, 'utf-8');
    
    // Check that movingTaskIds state is declared
    expect(fileContent).toContain('const [movingTaskIds, setMovingTaskIds] = useState<Set<string>>(new Set())');
    
    // Check that movingTaskIds is checked before updating tasks
    expect(fileContent).toContain('if (movingTaskIds.size === 0)');
    
    // Check that merge logic is present for non-moving tasks
    expect(fileContent).toContain('if (movingTaskIds.has(task.id))');
    expect(fileContent).toContain('return task; // Preserve local state for moving tasks');
    
    // Check that movingTaskIds is in the dependency array
    expect(fileContent).toMatch(/\}, \[.*movingTaskIds.*\]\)/);
  });
  
  it('should pass movingTaskIds props to TasksTab', () => {
    const projectPagePath = join(process.cwd(), 'src/pages/ProjectPage.tsx');
    const fileContent = readFileSync(projectPagePath, 'utf-8');
    
    // Check that movingTaskIds is passed as prop
    expect(fileContent).toContain('movingTaskIds={movingTaskIds}');
    expect(fileContent).toContain('setMovingTaskIds={setMovingTaskIds}');
  });
  
  it('should have TasksTab accept movingTaskIds props', () => {
    const tasksTabPath = join(process.cwd(), 'src/components/project-tasks/TasksTab.tsx');
    const fileContent = readFileSync(tasksTabPath, 'utf-8');
    
    // Check that TasksTab accepts the props
    expect(fileContent).toContain('movingTaskIds: Set<string>');
    expect(fileContent).toContain('setMovingTaskIds: (ids: Set<string>) => void');
  });
});