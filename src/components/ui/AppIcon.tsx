import type { LucideIcon, LucideProps } from 'lucide-react';

export const appIconProps = {
  strokeWidth: 1.75,
  absoluteStrokeWidth: true,
} satisfies Partial<LucideProps>;

export const AppIcon = ({
  icon: Icon,
  className,
}: {
  icon: LucideIcon;
  className?: string;
}) => <Icon className={className} {...appIconProps} />;
