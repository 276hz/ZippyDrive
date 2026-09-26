'use client';

import { useEffect } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function Error({ error, reset }: ErrorProps) {
  useEffect(() => {
    console.error('[ZippyDrive] Unhandled error:', error);
  }, [error]);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-4">
      <div className="max-w-md w-full surface gradient-border rounded-3xl p-8 text-center animate-reveal">
        <div className="w-12 h-12 rounded-2xl bg-signal-500/10 flex items-center justify-center mx-auto mb-4">
          <AlertTriangle className="w-6 h-6 text-signal-500" />
        </div>
        <h2 className="text-lg font-display font-bold text-white mb-2">Đã xảy ra lỗi không mong đợi</h2>
        <p className="text-sm text-ink-400 mb-1 font-mono break-all">
          {error.message || 'Lỗi không xác định.'}
        </p>
        {error.digest && (
          <p className="text-xs text-ink-600 mb-5 font-mono">ID: {error.digest}</p>
        )}
        <button
          onClick={reset}
          className="inline-flex items-center gap-2 rounded-lg bg-accent-400 hover:shadow-glow px-5 py-2.5 text-sm font-extrabold text-void-950 transition-all duration-300"
        >
          <RefreshCw className="w-4 h-4" />
          Thử lại
        </button>
      </div>
    </main>
  );
}
