export function LogoSVG({
  size = 20,
  variant = "green",
  className = "",
}: {
  size?: number;
  variant?: "green" | "black" | "white";
  className?: string;
}) {
  const fill =
    variant === "green"
      ? "#3AE478"
      : variant === "black"
        ? "#000000"
        : "#FFFFFF";
  const stroke =
    variant === "white"
      ? "#000000"
      : variant === "green"
        ? "#000000"
        : "#3AE478";
  const w = size * (190 / 200);
  return (
    <svg
      width={w}
      height={size}
      viewBox="0 0 190 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect y="10" width="180" height="180" fill={fill} />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M170 10H160V80H40V10H10V190H30V110H40V190H160V110H170V190H180V200H0V0H170V10ZM50 70H150V10H138V50H108V10H50V70Z"
        fill={stroke}
      />
      <path d="M190 190H180V20H190V190Z" fill={stroke} />
      <path d="M160 110H40V100H160V110Z" fill={stroke} />
      <path d="M180 20H170V10H180V20Z" fill={stroke} />
    </svg>
  );
}
