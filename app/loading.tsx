export default function Loading() {
  return (
    <main className="min-h-screen flex items-center justify-center">
      <div className="relative w-9 h-9">
        <div className="absolute inset-0 rounded-full border-2 border-accent-400/20" />
        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-accent-400 animate-spin" />
      </div>
    </main>
  );
}
