/* The sign-in screen the site opens on.
 *
 * It is a demonstration, not an authentication: there is no credential, no
 * request and nothing to get wrong. It holds for LOGIN_MS, then hands over.
 *
 * It renders over the boot gate rather than instead of it, so the dataset
 * fetch runs behind it -- by the time the mark fades the map is usually
 * already built, which is the point of spending the two seconds here.
 *
 * The bar is determinate because the wait really is fixed. A spinner would be
 * claiming not to know how long this takes.
 */

import { memo, useEffect, useState } from 'react';
import { BrandMark } from './BrandMark';
import { T } from '@/domain/strings';
import './login-splash.css';

/** How long the sign-in is shown, and the fade that follows it. */
export const LOGIN_MS = 2000;
const FADE_MS = 320;

export const LoginSplash = memo(function LoginSplash() {
  const [phase, setPhase] = useState<'in' | 'out' | 'done'>('in');

  useEffect(() => {
    const hold = setTimeout(() => setPhase('out'), LOGIN_MS);
    const gone = setTimeout(() => setPhase('done'), LOGIN_MS + FADE_MS);
    return () => {
      clearTimeout(hold);
      clearTimeout(gone);
    };
  }, []);

  if (phase === 'done') return null;

  return (
    <div
      className="login-splash"
      data-leaving={phase === 'out' || undefined}
      role="status"
      aria-live="polite"
    >
      <div className="login-splash__mark">
        <BrandMark height={168} cut="lockup" wordmark />
      </div>
      <p className="login-splash__status">{T.login.signingIn}</p>
      <div className="login-splash__bar" aria-hidden="true">
        <i style={{ animationDuration: `${LOGIN_MS}ms` }} />
      </div>
      <p className="login-splash__note">{T.login.note}</p>
    </div>
  );
});
