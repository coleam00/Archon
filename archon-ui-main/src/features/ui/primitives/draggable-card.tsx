import React from "react";
import { useDrag, useDrop } from "react-dnd";
import { Card, type CardProps } from "./card";

interface DraggableCardProps extends Omit<CardProps, "ref"> {
  // Drag and drop
  itemType: string;
  itemId: string;
  index: number;
  onDrop?: (draggedId: string, targetIndex: number) => void;

  // Visual states
  isDragging?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

export const DraggableCard = React.forwardRef<HTMLDivElement, DraggableCardProps>(
  ({ itemType, itemId, index, onDrop, onDragStart, onDragEnd, children, className, ...cardProps }, ref) => {
    const [{ isDragging }, drag] = useDrag({
      type: itemType,
      item: { id: itemId, index },
      collect: (monitor) => ({
        isDragging: !!monitor.isDragging(),
      }),
      end: () => {
        onDragEnd?.();
      },
    });

    const [{ isOver }, drop] = useDrop({
      accept: itemType,
      hover: (draggedItem: { id: string; index: number }) => {
        if (draggedItem.id === itemId) return;
        if (draggedItem.index === index) return;

        if (onDrop) {
          onDrop(draggedItem.id, index);
          draggedItem.index = index;
        }
      },
      collect: (monitor) => ({
        isOver: !!monitor.isOver(),
      }),
    });

    const combinedRef = (node: HTMLDivElement | null) => {
      drag(drop(node));
      if (typeof ref === "function") {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    };

    return (
      <div ref={combinedRef} className={isDragging ? "opacity-50 scale-95 transition-all" : "transition-all"}>
        <Card {...cardProps} className={className}>
          {children}
        </Card>
      </div>
    );
  },
);

DraggableCard.displayName = "DraggableCard";
