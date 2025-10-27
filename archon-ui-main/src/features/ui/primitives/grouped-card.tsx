import React from "react";
import { DataCard } from "./data-card";
import { cn } from "./styles";

interface GroupedCardProps extends React.HTMLAttributes<HTMLDivElement> {
  cards: Array<{
    id: string;
    title: string;
    edgeColor: "purple" | "blue" | "cyan" | "green" | "orange" | "pink" | "red";
    children?: React.ReactNode;
  }>;
  maxVisible?: number;
}

/**
 * GroupedCard - Stacked card component showing multiple cards in shuffle deck style
 *
 * Features:
 * - Shows 2-3 cards stacked on top of each other
 * - Top edge lights visible with fading effect
 * - Progressive scaling (each card ~5% smaller)
 * - Cards raised up behind top card with z-index layering
 */
export const GroupedCard = React.forwardRef<HTMLDivElement, GroupedCardProps>(
  ({ cards, maxVisible = 3, className, ...props }, ref) => {
    const visibleCards = cards.slice(0, maxVisible);
    const cardCount = visibleCards.length;

    return (
      <div ref={ref} className={cn("relative", className)} {...props}>
        {visibleCards.map((card, index) => {
          const isTop = index === 0;
          const zIndex = cardCount - index;
          const scale = 1 - index * 0.03; // 3% smaller per card
          const yOffset = index * 16; // 16px raised per card to show edge lights
          const opacity = 1 - index * 0.15; // Fade background cards slightly

          return (
            <div
              key={card.id}
              className="absolute inset-0 transition-all duration-300"
              style={{
                zIndex,
                transform: `scale(${scale}) translateY(-${yOffset}px)`,
                opacity: isTop ? 1 : opacity,
              }}
            >
              <DataCard
                edgePosition="top"
                edgeColor={card.edgeColor}
                blur="lg"
                className={cn("transition-all duration-300", !isTop && "pointer-events-none")}
              >
                {card.children || (
                  <div className="p-4">
                    <h4 className="font-medium text-white">{card.title}</h4>
                  </div>
                )}
              </DataCard>
            </div>
          );
        })}
        {/* Spacer to maintain height based on bottom card */}
        <div style={{ paddingBottom: `${(cardCount - 1) * 16}px`, opacity: 0 }}>
          <DataCard edgePosition="top" edgeColor={visibleCards[0]?.edgeColor || "cyan"}>
            <div className="p-4">
              <h4>{visibleCards[0]?.title || "Placeholder"}</h4>
            </div>
          </DataCard>
        </div>
      </div>
    );
  },
);

GroupedCard.displayName = "GroupedCard";
