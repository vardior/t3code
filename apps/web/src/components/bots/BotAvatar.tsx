export function BotAvatar({
  name,
  size = "default",
}: {
  readonly name: string;
  readonly size?: keyof typeof avatarSizes;
}) {
  const hue = [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${avatarSizes[size]}`}
      style={{ backgroundColor: `hsl(${hue} 45% 45%)` }}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
const avatarSizes = {
  default: "size-9 text-sm",
  sm: "size-5 text-3xs",
  xs: "size-4 text-4xs",
};
