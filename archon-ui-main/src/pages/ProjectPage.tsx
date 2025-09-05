import { ProjectsView } from '../features/projects';

// Minimal wrapper for routing compatibility
// All implementation is in features/projects/views/ProjectsView.tsx

function ProjectPage(props: any) {
  return <ProjectsView {...props} />;
}

export { ProjectPage };