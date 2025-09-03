import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('ProjectPage Performance Optimizations', () => {
  const projectPagePath = join(process.cwd(), 'src/pages/ProjectPage.tsx');
  const projectServicePath = join(process.cwd(), 'src/services/projectService.ts');
  
  it('should use batch API call for task counts instead of N+1 queries', () => {
    const fileContent = readFileSync(projectPagePath, 'utf-8');
    
    // Verify batch endpoint is being used
    expect(fileContent).toContain('getTaskCountsForAllProjects');
    
    // Verify we're NOT using Promise.allSettled for parallel fetching
    expect(fileContent).not.toContain('Promise.allSettled');
    
    // Verify single batch API call pattern
    expect(fileContent).toContain('await projectService.getTaskCountsForAllProjects()');
  });

  it('should have memoized handleProjectSelect to prevent duplicate calls', () => {
    const fileContent = readFileSync(projectPagePath, 'utf-8');
    
    // Check that handleProjectSelect is wrapped with useCallback
    expect(fileContent).toMatch(/const handleProjectSelect = useCallback\(/);
    
    // Check for early return if same project
    expect(fileContent).toContain('if (selectedProject?.id === project.id) return');
    
    // Check dependency array includes selectedProject?.id
    expect(fileContent).toMatch(/\}, \[.*selectedProject\?\.id.*\]\)/);
  });

  it('should implement task counts cache with TTL', () => {
    const fileContent = readFileSync(projectPagePath, 'utf-8');
    
    // Check cache ref is defined
    expect(fileContent).toContain('const taskCountsCache = useRef');
    
    // Check cache structure includes timestamp
    expect(fileContent).toContain('timestamp: number');
    
    // Check cache is checked before API call (5-minute TTL = 300000ms)
    expect(fileContent).toContain('(now - taskCountsCache.current.timestamp) < 300000');
    
    // Check cache is updated after successful API call
    expect(fileContent).toContain('taskCountsCache.current = {');
  });

  it('should disable polling during project switching and drag operations', () => {
    const fileContent = readFileSync(projectPagePath, 'utf-8');
    
    // Check useTaskPolling enabled parameter includes conditions
    expect(fileContent).toMatch(/enabled:.*!isSwitchingProject.*movingTaskIds\.size === 0/);
    
    // Verify isSwitchingProject state exists
    expect(fileContent).toContain('const [isSwitchingProject, setIsSwitchingProject]');
  });

  it('should have debounce utility implemented', () => {
    const debouncePath = join(process.cwd(), 'src/utils/debounce.ts');
    const fileContent = readFileSync(debouncePath, 'utf-8');
    
    // Check debounce function exists
    expect(fileContent).toContain('export function debounce');
    
    // Check it has proper TypeScript types
    expect(fileContent).toContain('T extends (...args: any[]) => any');
    
    // Check timeout clearing logic
    expect(fileContent).toContain('clearTimeout(timeoutId)');
  });

  it('should apply debouncing to loadTaskCountsForAllProjects', () => {
    const fileContent = readFileSync(projectPagePath, 'utf-8');
    
    // Check debounce is imported
    expect(fileContent).toContain('import { debounce } from "../utils/debounce"');
    
    // Check debounced version is created
    expect(fileContent).toContain('const debouncedLoadTaskCounts = useMemo');
    expect(fileContent).toContain('debounce((projectIds: string[])');
    
    // Check debounced version is used instead of direct calls
    expect(fileContent).toContain('debouncedLoadTaskCounts(projectIds)');
    
    // Verify 1000ms delay
    expect(fileContent).toContain('}, 1000)');
  });

  it('should have batch task counts endpoint in backend service', () => {
    const serviceContent = readFileSync(projectServicePath, 'utf-8');
    
    // Check the service method exists
    expect(serviceContent).toContain('async getTaskCountsForAllProjects()');
    
    // Check it calls the correct endpoint
    expect(serviceContent).toContain('/api/projects/task-counts');
    
    // Check return type
    expect(serviceContent).toContain('Promise<Record<string, TaskCounts>>');
  });

  it('should not make duplicate API calls on project switch', () => {
    const fileContent = readFileSync(projectPagePath, 'utf-8');
    
    // Check that tasks are cleared immediately on switch
    expect(fileContent).toContain('setTasks([]); // Clear stale tasks immediately');
    
    // Check loading state is managed properly
    expect(fileContent).toContain('setIsSwitchingProject(true)');
    expect(fileContent).toContain('setIsSwitchingProject(false)');
  });

  it('should have correct import statements for performance utilities', () => {
    const fileContent = readFileSync(projectPagePath, 'utf-8');
    
    // Check all necessary React hooks are imported
    expect(fileContent).toContain('useCallback');
    expect(fileContent).toContain('useMemo');
    expect(fileContent).toContain('useRef');
  });
});