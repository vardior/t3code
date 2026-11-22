export function BotAvatar({
  name,
  size = "default",
}: {
  readonly name: string;
  readonly size?: "default" | "sm";
}) {
  const hue = [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center rounded-full font-semibold text-white ${size === "sm" ? "size-5 text-3xs" : "size-9 text-sm"}`}
      style={{ backgroundColor: `hsl(${hue} 45% 45%)` }}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
