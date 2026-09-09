// ============================================================
// PODIUM.JS - Generic Podium Renderer
// ============================================================
window.Podium = (function() {
    const logoImg = new Image();
    logoImg.crossOrigin = 'anonymous';
    logoImg.src = 'sukipt-logo.png';

    function drawBase(ctx, template, tiers, tie = false, opts = {}) {
        const W = 1920, H = 1080;
        ctx.drawImage(template, 0, 0, W, H);
        const rects = {};
        const count = tiers.length;
        const totalWidth = 1600;
        const spacing = 60;
        const boxWidth = (totalWidth - (count - 1) * spacing) / count;
        const startX = (W - totalWidth) / 2;
        const baseY = 630;

        tiers.forEach((tier, idx) => {
            const x = startX + idx * (boxWidth + spacing);
            const heightOffset = (count - 1 - idx) * 40;
            const y = baseY - 160 - heightOffset;
            rects[tier.id] = [x, y, x + boxWidth, y + 240 + heightOffset];
            ctx.fillStyle = tier.color || '#ffffff';
            ctx.font = 'bold 48px Oswald, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(tier.label, x + boxWidth/2, y - 20);
        });
        return rects;
    }

    function drawContained(ctx, img, x0, y0, x1, y1, padding = 0.1) {
        if (!img || !img.complete || !img.naturalWidth) return;
        const iw = img.naturalWidth, ih = img.naturalHeight;
        const cw = x1 - x0, ch = y1 - y0;
        const padX = cw * padding, padY = ch * padding;
        const drawW = cw - padX * 2, drawH = ch - padY * 2;
        const scale = Math.min(drawW / iw, drawH / ih);
        const dw = iw * scale, dh = ih * scale;
        const dx = x0 + (cw - dw) / 2, dy = y0 + (ch - dh) / 2;
        ctx.drawImage(img, dx, dy, dw, dh);
    }

    function drawSport(ctx, img, name) {
        if (!img || !img.complete || !img.naturalWidth) return;
        const W = 1920;
        const y = 100, h = 140;
        const scale = Math.min(140 / img.naturalWidth, 140 / img.naturalHeight);
        const w = img.naturalWidth * scale;
        const x = (W - w) / 2;
        ctx.drawImage(img, x, y, w, h);
        ctx.fillStyle = '#1a1a2e';
        ctx.font = 'bold 64px Oswald, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(name, W/2, y + h + 80);
    }

    function makeCloth(template, tie, rect, logo) {
        const [x0, y0, x1, y1] = rect;
        const W = x1 - x0, H = y1 - y0;
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        if (logo && logo.complete) {
            drawContained(ctx, logo, 0, 0, W, H, 0.05);
        } else {
            ctx.fillStyle = '#eeeeee'; ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = '#999'; ctx.font = '20px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('Logo', W/2, H/2);
        }
        return canvas;
    }

    function drawWaving(ctx, clothCanvas, rect, time, phase) {
        const [x0, y0, x1, y1] = rect;
        const W = x1 - x0, H = y1 - y0;
        const cols = 20, rows = 15;
        const cw = W / cols, ch = H / rows;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const sx = c * cw, sy = r * ch;
                const amp = 6 * Math.sin(time * 2 + phase + (r / rows) * 2.5 + (c / cols) * 1.8);
                const dx = x0 + sx + amp * (r / rows);
                const dy = y0 + sy + 2 * Math.sin(time * 1.5 + phase + (c / cols) * 2.0);
                ctx.drawImage(clothCanvas, sx, sy, cw, ch, dx, dy, cw, ch);
            }
        }
    }

    return {
        logo: logoImg,
        drawBase: drawBase,
        drawContained: drawContained,
        drawSport: drawSport,
        makeCloth: makeCloth,
        drawWaving: drawWaving
    };
})();