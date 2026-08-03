import { useEffect } from 'react';
import type { RefObject } from 'react';

export function useClickOutside(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  useEffect(() => {
    function handleMouseDown(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as HTMLElement)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleMouseDown);
    return (): void => {
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [ref, onClose]);
}
