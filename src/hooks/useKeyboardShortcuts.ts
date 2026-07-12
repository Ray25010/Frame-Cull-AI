import { useCallback, useEffect } from 'react';
import { PhotoRating, SelectionState } from '../types';
import { useShortcuts } from '../contexts/ShortcutsContext';

interface UseKeyboardShortcutsOptions {
  enabled: boolean;
  onNavigate: (direction: 'prev' | 'next') => void;
  onUpdateSelection: (state: SelectionState) => void;
  onUpdateRating?: (rating: PhotoRating) => void;
  onToggleAiOverlay?: () => void;
  onSelectAll?: () => void;
  onClearSelection?: () => void;
}

export function useKeyboardShortcuts({
  enabled,
  onNavigate,
  onUpdateSelection,
  onUpdateRating,
  onToggleAiOverlay,
  onSelectAll,
  onClearSelection,
}: UseKeyboardShortcutsOptions) {
  const { getActionByKey } = useShortcuts();

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    const activeTag = document.activeElement?.tagName || '';
    const isEditingText = document.activeElement instanceof HTMLElement && document.activeElement.isContentEditable;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)) return;
    if (isEditingText) return;
    if (!enabled) return;

    const key = event.key.toLowerCase();
    const isModifierShortcut = event.ctrlKey || event.metaKey;

    if (isModifierShortcut && key === 'a') {
      event.preventDefault();
      onSelectAll?.();
      return;
    }

    if (isModifierShortcut && key === 'd') {
      event.preventDefault();
      onClearSelection?.();
      return;
    }

    if (/^[0-5]$/.test(key)) {
      event.preventDefault();
      onUpdateRating?.(Number(key) as PhotoRating);
      return;
    }

    const action = getActionByKey(key);
    if (!action) return;

    if (key === ' ') event.preventDefault();

    switch (action) {
      case 'navigate_next':
        onNavigate('next');
        break;
      case 'navigate_prev':
        onNavigate('prev');
        break;
      case 'mark_picked':
        onUpdateSelection(SelectionState.PICKED);
        break;
      case 'mark_rejected':
        onUpdateSelection(SelectionState.REJECTED);
        break;
      case 'mark_unmarked':
        onUpdateSelection(SelectionState.UNMARKED);
        break;
      case 'toggle_ai_overlay':
        event.preventDefault();
        onToggleAiOverlay?.();
        break;
    }
  }, [enabled, getActionByKey, onClearSelection, onNavigate, onSelectAll, onToggleAiOverlay, onUpdateRating, onUpdateSelection]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}
