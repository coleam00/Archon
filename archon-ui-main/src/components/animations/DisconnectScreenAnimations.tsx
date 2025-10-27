import React, { useEffect, useRef } from 'react';

/**
 * Disconnect Screen
 * Frosted glass medallion with aurora borealis light show behind it
 */
export const DisconnectScreen: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    let time = 0;

    const drawAurora = () => {
      // Create dark background with vignette
      const gradient = ctx.createRadialGradient(
        canvas.width / 2, canvas.height / 2, 0,
        canvas.width / 2, canvas.height / 2, canvas.width / 1.5
      );
      gradient.addColorStop(0, 'rgba(0, 0, 0, 0.3)');
      gradient.addColorStop(1, 'rgba(0, 0, 0, 0.95)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw aurora waves with varying opacity
      const colors = [
        { r: 34, g: 211, b: 238, a: 0.4 },  // Cyan
        { r: 168, g: 85, b: 247, a: 0.4 },  // Purple
        { r: 236, g: 72, b: 153, a: 0.4 },  // Pink
        { r: 59, g: 130, b: 246, a: 0.4 },  // Blue
        { r: 16, g: 185, b: 129, a: 0.4 },  // Green
      ];

      colors.forEach((color, index) => {
        ctx.beginPath();
        
        const waveHeight = 250;
        const waveOffset = index * 60;
        const speed = 0.001 + index * 0.0002;
        
        // Animate opacity for ethereal effect
        const opacityWave = Math.sin(time * 0.0005 + index) * 0.2 + 0.3;
        
        for (let x = 0; x <= canvas.width; x += 5) {
          const y = canvas.height / 2 + 
            Math.sin(x * 0.003 + time * speed) * waveHeight +
            Math.sin(x * 0.005 + time * speed * 1.5) * (waveHeight / 2) +
            Math.sin(x * 0.002 + time * speed * 0.5) * (waveHeight / 3) +
            waveOffset - 100;
          
          if (x === 0) {
            ctx.moveTo(x, y);
          } else {
            ctx.lineTo(x, y);
          }
        }
        
        // Create gradient for each wave with animated opacity
        const waveGradient = ctx.createLinearGradient(0, canvas.height / 2 - 300, 0, canvas.height / 2 + 300);
        waveGradient.addColorStop(0, `rgba(${color.r}, ${color.g}, ${color.b}, 0)`);
        waveGradient.addColorStop(0.5, `rgba(${color.r}, ${color.g}, ${color.b}, ${opacityWave})`);
        waveGradient.addColorStop(1, `rgba(${color.r}, ${color.g}, ${color.b}, 0)`);
        
        ctx.strokeStyle = waveGradient;
        ctx.lineWidth = 4;
        ctx.stroke();
        
        // Add enhanced glow effect
        ctx.shadowBlur = 40;
        ctx.shadowColor = `rgba(${color.r}, ${color.g}, ${color.b}, 0.6)`;
        ctx.stroke();
        ctx.shadowBlur = 0;
      });

      time += 16;
      requestAnimationFrame(drawAurora);
    };

    drawAurora();

    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return (
    <div className="relative w-full h-full bg-black overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0" />
      
      {/* Glass medallion with frosted effect - made bigger */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative">
          {/* Glowing orb effect */}
          <div 
            className="absolute inset-0 w-96 h-96 rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(34, 211, 238, 0.3) 0%, rgba(168, 85, 247, 0.2) 40%, transparent 70%)',
              filter: 'blur(40px)',
              animation: 'glow 4s ease-in-out infinite',
            }}
          />
          
          {/* Frosted glass background */}
          <div 
            className="absolute inset-0 w-96 h-96 rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 50%, transparent 100%)',
              backdropFilter: 'blur(20px)',
              border: '3px solid rgba(255,255,255,0.25)',
              boxShadow: `
                inset 0 0 40px rgba(255,255,255,0.1), 
                0 0 80px rgba(34, 211, 238, 0.5),
                0 0 120px rgba(168, 85, 247, 0.4),
                0 0 160px rgba(34, 211, 238, 0.3),
                0 0 200px rgba(168, 85, 247, 0.2)
              `,
            }}
          />
          
          {/* Embossed logo - made bigger */}
          <div className="relative w-96 h-96 flex items-center justify-center">
            <img 
              src="/logo-neon.png" 
              alt="Archon" 
              className="w-64 h-64 z-10"
              style={{
                filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.4)) drop-shadow(0 -2px 4px rgba(255,255,255,0.3))',
                opacity: 0.9,
                mixBlendMode: 'screen',
              }}
            />
          </div>
          
          {/* Disconnected Text - Glass style with red glow */}
          <div className="absolute -bottom-20 left-1/2 transform -translate-x-1/2">
            <div 
              className="px-8 py-4 rounded-full"
              style={{
                background: 'rgba(255, 255, 255, 0.05)',
                backdropFilter: 'blur(10px)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                boxShadow: '0 0 30px rgba(239, 68, 68, 0.5), inset 0 0 20px rgba(239, 68, 68, 0.2)',
              }}
            >
              <span 
                className="text-2xl font-medium tracking-wider"
                style={{
                  color: 'rgba(239, 68, 68, 0.9)',
                  textShadow: '0 0 20px rgba(239, 68, 68, 0.8), 0 0 40px rgba(239, 68, 68, 0.6)',
                }}
              >
                DISCONNECTED
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};