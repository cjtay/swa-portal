/*
 * Public namecard page client script.
 *
 * Responsibilities:
 *   - Draw the QR code into the .nc-qr-canvas element using the global QRCode
 *     library (loaded via /js/qrcode.min.js, vendored by the copy:qrcode
 *     prebuild hook).
 *   - Overlay the SWA badge logo at the centre of the QR (≤15% of width, on a
 *     white circular backdrop) with errorCorrectionLevel='H' so the logo
 *     does not break scanning.
 *   - Wire the "Save QR image" button to download the canvas as a PNG.
 *   - Wire the "Save card image" button to fetch the SVG card, rasterise it
 *     to a canvas, and download as PNG.
 *
 * ── Canvas-taint rule ───────────────────────────────────────────────────────
 * Every visual asset drawn onto a canvas MUST be inlined (data URI or inline
 * SVG). An external <img src="https://…"> taints the canvas and silently
 * breaks toDataURL('image/png'). The SWA badge is loaded from the inlined
 * data URI produced by swa-monogram.ts (server-side) and baked into this file
 * at build time. The card SVG endpoint serves an SVG with all assets inlined
 * (see namecard-svg.ts), so drawing it into a canvas is safe.
 */
(function () {
  'use strict';

  // Path to the SWA logo. Same asset the PayNow QR uses
  // (src/pages/reg/membership/register.astro:187) and the admin nav uses
  // (src/layouts/AdminLayout.astro:64). Loaded same-origin — does NOT taint
  // the canvas, so toDataURL('image/png') works for the QR + card image
  // downloads. The WebP decodes reliably with proper alpha everywhere
  // (some browsers mis-rasterise transparent SVG corners as black, which is
  // why we use the WebP rather than /swalogo.svg here).
  var SWA_LOGO_SRC = '/swa-logo.webp';

  var QR_DARK = '#000000'; // match PayNow QR (register.astro) — scans reliably
  var QR_LIGHT = '#ffffff';

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  function drawCenterLogo(canvas, ctx) {
    // Mirrors the PayNow QR overlay in src/pages/reg/membership/register.astro:172.
    // White circular backdrop, then the SWA logo centred on top at diameter
    // r*1.4 — slightly overlapping the circle edge. The WebP's transparent
    // corners let the white circle show through; no clipping needed.
    // errorCorrectionLevel='H' (set in renderQr) keeps the QR scannable even
    // with the centre covered.
    return new Promise(function (resolve) {
      var logo = new Image();
      logo.onload = function () {
        var size = canvas.width;
        var r = size * 0.16;
        var cx = size / 2;
        var cy = size / 2;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.drawImage(logo, cx - r * 0.7, cy - r * 0.7, r * 1.4, r * 1.4);
        resolve();
      };
      logo.onerror = function () {
        resolve(); // logo optional; QR still scans.
      };
      logo.src = SWA_LOGO_SRC;
    });
  }

  function renderQr(canvas, payload) {
    return new Promise(function (resolve, reject) {
      // Guard against the qrcode lib not having loaded yet.
      if (typeof window.QRCode === 'undefined') {
        // Retry until the script tag loads (it's defer'd).
        var tries = 0;
        var wait = setInterval(function () {
          if (typeof window.QRCode !== 'undefined') {
            clearInterval(wait);
            renderQr(canvas, payload).then(resolve, reject);
          } else if (++tries > 100) {
            clearInterval(wait);
            reject(new Error('QR library failed to load'));
          }
        }, 50);
        return;
      }
      window.QRCode.toCanvas(
        canvas,
        payload,
        {
          width: 540,
          margin: 1,
          errorCorrectionLevel: 'H', // mandatory with the centre logo
          color: { dark: QR_DARK, light: QR_LIGHT },
        },
        async function (err) {
          if (err) {
            reject(err);
            return;
          }
          // The qrcode library writes inline width/height matching its
          // backing store (540px), which overrides the .nc-qr-canvas CSS
          // rule and overflows the 440px card. Force the display size back
          // to 240px — exactly what the PayNow QR does (register.astro:170).
          canvas.style.width = '240px';
          canvas.style.height = '240px';
          try {
            await drawCenterLogo(canvas, canvas.getContext('2d'));
            resolve();
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  }

  function downloadDataUrl(dataUrl, filename) {
    var a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function downloadSvgCardAsPng(svgUrl, slug) {
    return fetch(svgUrl)
      .then(function (r) {
        if (!r.ok) throw new Error('card.svg fetch failed: ' + r.status);
        return r.text();
      })
      .then(function (svgText) {
        return new Promise(function (resolve, reject) {
          var img = new Image();
          // Inline SVG via blob URL — keeps the canvas untainted (same-origin).
          var blob = new Blob([svgText], { type: 'image/svg+xml' });
          var url = URL.createObjectURL(blob);
          img.onload = function () {
            var canvas = document.createElement('canvas');
            canvas.width = 1050;
            canvas.height = 600;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
            URL.revokeObjectURL(url);
            try {
              var dataUrl = canvas.toDataURL('image/png');
              downloadDataUrl(dataUrl, slug + '-card.png');
              resolve();
            } catch (e) {
              // Canvas was tainted — shouldn't happen given the SVG is
              // fully inlined, but surface it loudly if it does.
              reject(new Error('Card image export failed (canvas tainted?): ' + e.message));
            }
          };
          img.onerror = function () {
            URL.revokeObjectURL(url);
            reject(new Error('Could not render the card SVG.'));
          };
          img.src = url;
        });
      });
  }

  function getSlug() {
    var parts = window.location.pathname.split('/').filter(Boolean);
    // /c/{slug} → parts[0] === 'c'
    return parts.length >= 2 && parts[0] === 'c' ? parts[1] : 'namecard';
  }

  ready(function () {
    var canvas = document.querySelector('.nc-qr-canvas');
    var slug = getSlug();

    // Pre-fill the QR payload from the page's canonical URL (the .vcf file).
    // Prefer the data-qr attribute if a future page revision sets it.
    var qrPayload = window.location.origin + '/c/' + slug + '/contact.vcf';

    if (canvas) {
      renderQr(canvas, qrPayload).catch(function () {
        // Hide the QR panel rather than show a broken canvas.
        var panel = canvas.closest('.nc-qr');
        if (panel) panel.style.display = 'none';
      });
    }

    document.addEventListener('click', function (e) {
      var target = e.target;
      if (!(target instanceof HTMLElement)) return;
      var action = target.dataset.action;

      if (action === 'save-qr' && canvas) {
        try {
          var dataUrl = canvas.toDataURL('image/png');
          downloadDataUrl(dataUrl, slug + '-qr.png');
        } catch (err) {
          alert('Sorry, the QR image could not be saved. ' + err.message);
        }
      }

      if (action === 'save-card') {
        var svgUrl = target.dataset.url || window.location.origin + '/c/' + slug + '/card.svg';
        var btn = target;
        var original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Preparing…';
        downloadSvgCardAsPng(svgUrl, slug)
          .then(function () {
            btn.disabled = false;
            btn.textContent = original;
          })
          .catch(function (err) {
            btn.disabled = false;
            btn.textContent = original;
            alert('Sorry, the card image could not be saved. ' + err.message);
          });
      }
    });
  });
})();
