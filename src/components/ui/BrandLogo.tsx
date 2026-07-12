import framecullMark from '../../assets/brand/framecull-mark.png';
import { PRODUCT_DISPLAY_NAME } from '../../utils/appInfo';

interface BrandLogoProps {
  className?: string;
  markClassName?: string;
  showName?: boolean;
  nameClassName?: string;
}

export const BrandLogo = ({
  className = '',
  markClassName = '',
  showName = true,
  nameClassName = '',
}: BrandLogoProps) => (
  <div className={`flex min-w-0 items-center gap-1.5 ${className}`}>
    <img
      src={framecullMark}
      alt="FrameCull AI Logo"
      className={`pointer-events-none h-6 w-6 rounded-md object-cover ${markClassName}`}
      draggable={false}
    />
    {showName && (
      <span className={`hidden truncate text-[12px] font-semibold pointer-events-none sm:inline ${nameClassName}`}>
        {PRODUCT_DISPLAY_NAME}
      </span>
    )}
  </div>
);
