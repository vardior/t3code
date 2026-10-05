export function BotAvatar({ name }: { readonly name: string }) {
  const hue = [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
  return (
    <span
      aria-hidden
      className="flex size-9 shrink-0 items-center justify-center rounded-full font-semibold text-sm text-white"
      style={{ backgroundColor: `hsl(${hue} 45% 45%)` }}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
