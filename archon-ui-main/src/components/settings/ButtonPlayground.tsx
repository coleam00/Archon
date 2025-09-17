import React, { useState } from 'react';
import { Copy, Check, Link, Unlink } from 'lucide-react';
import { NeonButton, type CornerRadius, type GlowIntensity, type ColorOption } from '../ui/NeonButton';
import { motion } from 'framer-motion';
import { cn } from '../../lib/utils';
import { copyToClipboard } from '../../features/shared/utils/clipboard';

export const ButtonPlayground: React.FC = () => {
  const [showLayer2, setShowLayer2] = useState(true);
  const [layer2Inset, setLayer2Inset] = useState(8);
  const [layer1Color, setLayer1Color] = useState<ColorOption>('none');
  const [layer2Color, setLayer2Color] = useState<ColorOption>('pink');
  const [layer1Border, setLayer1Border] = useState(true);
  const [layer2Border, setLayer2Border] = useState(true);
  const [coloredText, setColoredText] = useState(true);
  const [activeTab, setActiveTab] = useState<'layer1' | 'layer2'>('layer1');
  
  // Glow controls
  const [layer1Glow, setLayer1Glow] = useState<GlowIntensity>('md');
  const [layer2Glow, setLayer2Glow] = useState<GlowIntensity>('md');
  const [borderGlow, setBorderGlow] = useState<GlowIntensity>('none');
  
  // Corner radius
  const [layer1Radius, setLayer1Radius] = useState<CornerRadius>({
    topLeft: 12,
    topRight: 12,
    bottomRight: 12,
    bottomLeft: 12
  });
  const [layer2Radius, setLayer2Radius] = useState<CornerRadius>({
    topLeft: 24,
    topRight: 24,
    bottomRight: 24,
    bottomLeft: 24
  });
  
  // Corner linking state
  const [layer1Linked, setLayer1Linked] = useState({
    topLeft: true,
    topRight: true,
    bottomRight: true,
    bottomLeft: true
  });
  const [layer2Linked, setLayer2Linked] = useState({
    topLeft: true,
    topRight: true,
    bottomRight: true,
    bottomLeft: true
  });
  
  const [copied, setCopied] = useState(false);

  const colors: ColorOption[] = ['none', 'purple', 'pink', 'blue', 'green', 'red'];
  const glowOptions: GlowIntensity[] = ['none', 'sm', 'md', 'lg', 'xl', 'xxl'];

  // Handle corner changes with linking
  const handleCornerChange = (
    layer: 'layer1' | 'layer2',
    corner: keyof CornerRadius,
    value: number,
    linked: any,
    setRadius: any
  ) => {
    if (layer === 'layer1') {
      if (linked[corner]) {
        // Update all linked corners
        const newRadius: CornerRadius = {};
        Object.keys(linked).forEach(key => {
          if (linked[key as keyof CornerRadius]) {
            newRadius[key as keyof CornerRadius] = value;
          } else {
            newRadius[key as keyof CornerRadius] = layer1Radius[key as keyof CornerRadius];
          }
        });
        setRadius(newRadius);
      } else {
        setRadius((prev: CornerRadius) => ({ ...prev, [corner]: value }));
      }
    } else {
      if (linked[corner]) {
        // Update all linked corners
        const newRadius: CornerRadius = {};
        Object.keys(linked).forEach(key => {
          if (linked[key as keyof CornerRadius]) {
            newRadius[key as keyof CornerRadius] = value;
          } else {
            newRadius[key as keyof CornerRadius] = layer2Radius[key as keyof CornerRadius];
          }
        });
        setRadius(newRadius);
      } else {
        setRadius((prev: CornerRadius) => ({ ...prev, [corner]: value }));
      }
    }
  };

  const toggleLink = (layer: 'layer1' | 'layer2', corner: keyof CornerRadius) => {
    if (layer === 'layer1') {
      setLayer1Linked(prev => ({ ...prev, [corner]: !prev[corner] }));
    } else {
      setLayer2Linked(prev => ({ ...prev, [corner]: !prev[corner] }));
    }
  };

  const generateCSS = () => {
    const layer1BorderRadius = `${layer1Radius.topLeft}px ${layer1Radius.topRight}px ${layer1Radius.bottomRight}px ${layer1Radius.bottomLeft}px`;
    const layer2BorderRadius = `${layer2Radius.topLeft}px ${layer2Radius.topRight}px ${layer2Radius.bottomRight}px ${layer2Radius.bottomLeft}px`;
    
    let css = `.neon-button {
  /* Base button styles */
  position: relative;
  padding: 12px 24px;
  font-weight: 500;
  transition: all 300ms;
  cursor: pointer;
  overflow: hidden;
  
  /* Layer 1 - Main glass layer */
  background: ${layer1Color === 'none' 
    ? 'rgba(255,255,255,0.9)' 
    : 'rgba(255,255,255,0.9)'};
  background: ${layer1Color === 'none' 
    ? 'rgba(0,0,0,0.9)' 
    : 'rgba(0,0,0,0.9)'} !important; /* Dark mode */
  backdrop-filter: blur(8px);
  border-radius: ${layer1BorderRadius};
  ${layer1Border ? `border: 1px solid ${layer1Color === 'none' ? 'rgba(255,255,255,0.2)' : getColorConfig(layer1Color).border.split(' ')[1]};` : ''}
  ${layer1Glow !== 'none' ? `box-shadow: 0 0 ${getGlowConfig(layer1Glow).blur}px ${getColorConfig(layer1Color).glow};` : ''}
}

.neon-button span {
  /* Text styling */
  position: relative;
  z-index: 10;
  font-weight: 500;
  ${coloredText 
    ? (showLayer2 && layer2Color !== 'none'
        ? `color: ${getColorConfig(layer2Color).text};
  text-shadow: 0 1px 2px rgba(0,0,0,0.8);`
        : layer1Color !== 'none'
          ? `color: ${getColorConfig(layer1Color).text};
  text-shadow: 0 1px 2px rgba(0,0,0,0.8);`
          : `color: rgba(255, 255, 255, 0.8);`)
    : `color: rgba(255, 255, 255, 0.8);
  mix-blend-mode: screen;`}
}`;

    if (showLayer2) {
      css += `

.neon-button::before {
  /* Layer 2 - Inner glass pill */
  content: '';
  position: absolute;
  top: ${layer2Inset}px;
  left: ${layer2Inset}px;
  right: ${layer2Inset}px;
  bottom: ${layer2Inset}px;
  background: ${layer2Color === 'none' 
    ? 'linear-gradient(to bottom, rgba(255,255,255,0.2), rgba(0,0,0,0.2))' 
    : layer2Color === 'purple'
      ? 'linear-gradient(to bottom, rgba(168,85,247,0.3), rgba(147,51,234,0.3))'
      : layer2Color === 'pink'
        ? 'linear-gradient(to bottom, rgba(236,72,153,0.3), rgba(219,39,119,0.3))'
        : layer2Color === 'blue'
          ? 'linear-gradient(to bottom, rgba(59,130,246,0.3), rgba(37,99,235,0.3))'
          : layer2Color === 'green'
            ? 'linear-gradient(to bottom, rgba(34,197,94,0.3), rgba(22,163,74,0.3))'
            : 'linear-gradient(to bottom, rgba(239,68,68,0.3), rgba(220,38,38,0.3))'};
  backdrop-filter: blur(4px);
  border-radius: ${layer2BorderRadius};
  ${layer2Border ? `border: 1px solid ${layer2Color === 'none' ? 'rgba(255,255,255,0.2)' : getColorConfig(layer2Color).border.split(' ')[1]};` : ''}
  ${layer2Glow !== 'none' ? `box-shadow: 0 0 ${getGlowConfig(layer2Glow).blur}px ${getColorConfig(layer2Color).glow};` : ''}
  pointer-events: none;
}`;
    }

    if (borderGlow !== 'none') {
      css += `

.neon-button::after {
  /* Border glow effect */
  content: '';
  position: absolute;
  inset: -2px;
  background: linear-gradient(45deg, #f06292, #9c27b0, #3f51b5, #00bcd4, #4caf50, #ffeb3b, #ff5722);
  background-size: 400% 400%;
  animation: gradient-rotate 15s ease infinite;
  border-radius: ${layer1BorderRadius};
  opacity: ${getGlowConfig(borderGlow).opacity};
  filter: blur(${parseInt(getGlowConfig(borderGlow).blur.toString()) / 2}px);
  pointer-events: none;
  z-index: -1;
}

@keyframes gradient-rotate {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}`;
    }

    return css;
  };

  // Helper functions for CSS generation
  const getSizePadding = () => {
    const sizes = { sm: '12px 6px', md: '16px 8px', lg: '24px 12px', xl: '32px 16px' };
    return sizes['md'];
  };

  const getGlowConfig = (intensity: GlowIntensity) => {
    const configs = {
      none: { blur: 0, spread: 0, opacity: 0 },
      sm: { blur: 10, spread: 15, opacity: 0.3 },
      md: { blur: 20, spread: 25, opacity: 0.4 },
      lg: { blur: 30, spread: 35, opacity: 0.5 },
      xl: { blur: 40, spread: 45, opacity: 0.6 },
      xxl: { blur: 60, spread: 65, opacity: 0.7 }
    };
    return configs[intensity];
  };

  const getColorConfig = (color: ColorOption) => {
    const configs = {
      none: {
        border: 'border-white/20',
        glow: 'rgba(255,255,255,0.4)',
        glowDark: 'rgba(255,255,255,0.3)',
        text: 'rgb(156 163 175)'
      },
      purple: {
        border: 'border-purple-400/30',
        glow: 'rgba(168,85,247,0.6)',
        glowDark: 'rgba(168,85,247,0.5)',
        text: 'rgb(168 85 247)'
      },
      pink: {
        border: 'border-pink-400/30',
        glow: 'rgba(236,72,153,0.6)',
        glowDark: 'rgba(236,72,153,0.5)',
        text: 'rgb(236 72 153)'
      },
      blue: {
        border: 'border-blue-400/30',
        glow: 'rgba(59,130,246,0.6)',
        glowDark: 'rgba(59,130,246,0.5)',
        text: 'rgb(59 130 246)'
      },
      green: {
        border: 'border-green-400/30',
        glow: 'rgba(34,197,94,0.6)',
        glowDark: 'rgba(34,197,94,0.5)',
        text: 'rgb(34 197 94)'
      },
      red: {
        border: 'border-red-400/30',
        glow: 'rgba(239,68,68,0.6)',
        glowDark: 'rgba(239,68,68,0.5)',
        text: 'rgb(239 68 68)'
      }
    };
    return configs[color];
  };

  const getGradient = (color: ColorOption) => {
    if (color === 'none') return 'rgba(255,255,255,0.8), rgba(255,255,255,0.6)';
    return 'rgba(255,255,255,0.7), rgba(255,255,255,0.5)';
  };

  const getBorderColor = (color: ColorOption) => {
    const colors = {
      none: 'rgba(229,231,235,0.5)',
      purple: 'rgba(196,181,253,0.6)',
      pink: 'rgba(251,207,232,0.6)',
      blue: 'rgba(147,197,253,0.6)',
      green: 'rgba(134,239,172,0.6)',
      red: 'rgba(252,165,165,0.6)'
    };
    return colors[color];
  };

  const handleCopyToClipboard = async () => {
    const result = await copyToClipboard(generateCSS());
    if (result.success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      console.error('Failed to copy to clipboard:', result.error);
    }
  };

  // Corner input component
  const CornerInput = ({ 
    layer, 
    corner, 
    value, 
    linked, 
    onChange 
  }: { 
    layer: 'layer1' | 'layer2';
    corner: keyof CornerRadius;
    value: number;
    linked: boolean;
    onChange: (value: number) => void;
  }) => (
    <div className="flex items-center gap-1">
      <button
        onClick={() => toggleLink(layer, corner)}
        className={cn(
          'w-5 h-5 rounded border transition-all flex items-center justify-center',
          linked 
            ? 'bg-blue-500 border-blue-600 text-white' 
            : 'bg-gray-200 dark:bg-gray-700 border-gray-300 dark:border-gray-600'
        )}
      >
        {linked ? <Link className="w-3 h-3" /> : <Unlink className="w-3 h-3" />}
      </button>
      <input
        type="number"
        min="0"
        max="50"
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value) || 0)}
        className="w-12 px-1 py-0.5 text-sm text-center bg-white/50 dark:bg-black/50 border border-gray-300 dark:border-gray-600 rounded"
      />
    </div>
  );

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="space-y-8"
    >
      <h2 className="text-2xl font-bold text-gray-800 dark:text-white">Glass Button Lab</h2>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Left Column - Preview and Controls */}
        <div className="relative rounded-xl backdrop-blur-md
          bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30
          border border-gray-200 dark:border-zinc-800/50
          shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]">
          
          {/* Preview Section */}
          <div className="p-6 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-white mb-4">Preview</h3>
            <div className="flex items-center justify-center min-h-[150px] bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black rounded-lg p-8">
              <NeonButton
                showLayer2={showLayer2}
                layer2Inset={layer2Inset}
                layer1Color={layer1Color}
                layer2Color={layer2Color}
                layer1Border={layer1Border}
                layer2Border={layer2Border}
                layer1Radius={layer1Radius}
                layer2Radius={layer2Radius}
                layer1Glow={layer1Glow}
                layer2Glow={layer2Glow}
                borderGlow={borderGlow}
                coloredText={coloredText}
              >
                Click Me
              </NeonButton>
            </div>
          </div>

          {/* Tab Controls */}
          <div className="p-6">
            <div className="space-y-3">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">Controls</h3>
              
              {/* Text Color Control */}
              <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  checked={coloredText}
                  onChange={(e) => setColoredText(e.target.checked)}
                  className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-purple-600"
                />
                Colored Text (takes button color)
              </label>
              
              {/* Tab Selection */}
              <div className="flex items-center gap-2 border-b border-gray-200 dark:border-gray-700">
                <button
                  onClick={() => setActiveTab('layer1')}
                  className={cn(
                    'px-4 py-2 text-sm font-medium transition-colors relative',
                    activeTab === 'layer1' 
                      ? 'text-purple-600 dark:text-purple-400' 
                      : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                  )}
                >
                  Layer 1
                  {activeTab === 'layer1' && (
                    <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-600 dark:bg-purple-400" />
                  )}
                </button>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setActiveTab('layer2')}
                    className={cn(
                      'px-4 py-2 text-sm font-medium transition-colors relative',
                      activeTab === 'layer2' 
                        ? 'text-purple-600 dark:text-purple-400' 
                        : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                    )}
                  >
                    Layer 2
                    {activeTab === 'layer2' && (
                      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-purple-600 dark:bg-purple-400" />
                    )}
                  </button>
                  <input
                    type="checkbox"
                    checked={showLayer2}
                    onChange={(e) => setShowLayer2(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-purple-600"
                  />
                </div>
              </div>
            </div>

            {/* Tab Content */}
            <div className="space-y-4">
              {activeTab === 'layer1' ? (
                <>
                  {/* Layer 1 Controls */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Color</label>
                      <select
                        value={layer1Color}
                        onChange={(e) => setLayer1Color(e.target.value as ColorOption)}
                        className="w-full px-2 py-1 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded"
                      >
                        {colors.map(color => (
                          <option key={color} value={color}>
                            {color.charAt(0).toUpperCase() + color.slice(1)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Glow</label>
                      <select
                        value={layer1Glow}
                        onChange={(e) => setLayer1Glow(e.target.value as GlowIntensity)}
                        className="w-full px-2 py-1 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded"
                      >
                        {glowOptions.map(option => (
                          <option key={option} value={option}>
                            {option.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                      <input
                        type="checkbox"
                        checked={layer1Border}
                        onChange={(e) => setLayer1Border(e.target.checked)}
                        className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-purple-600"
                      />
                      Border
                    </label>
                    <div>
                      <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Border Glow</label>
                      <select
                        value={borderGlow}
                        onChange={(e) => setBorderGlow(e.target.value as GlowIntensity)}
                        className="w-full px-2 py-1 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded"
                      >
                        {glowOptions.map(option => (
                          <option key={option} value={option}>
                            {option.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-600 dark:text-gray-400 mb-2">Corner Radius</label>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-600 dark:text-gray-400">TL</span>
                        <CornerInput
                          layer="layer1"
                          corner="topLeft"
                          value={layer1Radius.topLeft || 0}
                          linked={layer1Linked.topLeft}
                          onChange={(value) => handleCornerChange('layer1', 'topLeft', value, layer1Linked, setLayer1Radius)}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-600 dark:text-gray-400">TR</span>
                        <CornerInput
                          layer="layer1"
                          corner="topRight"
                          value={layer1Radius.topRight || 0}
                          linked={layer1Linked.topRight}
                          onChange={(value) => handleCornerChange('layer1', 'topRight', value, layer1Linked, setLayer1Radius)}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-600 dark:text-gray-400">BL</span>
                        <CornerInput
                          layer="layer1"
                          corner="bottomLeft"
                          value={layer1Radius.bottomLeft || 0}
                          linked={layer1Linked.bottomLeft}
                          onChange={(value) => handleCornerChange('layer1', 'bottomLeft', value, layer1Linked, setLayer1Radius)}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-600 dark:text-gray-400">BR</span>
                        <CornerInput
                          layer="layer1"
                          corner="bottomRight"
                          value={layer1Radius.bottomRight || 0}
                          linked={layer1Linked.bottomRight}
                          onChange={(value) => handleCornerChange('layer1', 'bottomRight', value, layer1Linked, setLayer1Radius)}
                        />
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  {/* Layer 2 Controls */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Color</label>
                      <select
                        value={layer2Color}
                        onChange={(e) => setLayer2Color(e.target.value as ColorOption)}
                        className="w-full px-2 py-1 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded"
                        disabled={!showLayer2}
                      >
                        {colors.map(color => (
                          <option key={color} value={color}>
                            {color.charAt(0).toUpperCase() + color.slice(1)}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">Glow</label>
                      <select
                        value={layer2Glow}
                        onChange={(e) => setLayer2Glow(e.target.value as GlowIntensity)}
                        className="w-full px-2 py-1 text-sm bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 rounded"
                        disabled={!showLayer2}
                      >
                        {glowOptions.map(option => (
                          <option key={option} value={option}>
                            {option.toUpperCase()}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                      Layer 2 Inset: {layer2Inset}px
                    </label>
                    <input
                      type="range"
                      min="-20"
                      max="20"
                      value={layer2Inset}
                      onChange={(e) => setLayer2Inset(parseInt(e.target.value))}
                      className="w-full"
                      disabled={!showLayer2}
                    />
                    <div className="flex justify-between text-xs text-gray-500 dark:text-gray-500 mt-1">
                      <span>-20px (overlap)</span>
                      <span>0px</span>
                      <span>20px (inset)</span>
                    </div>
                  </div>

                  <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <input
                      type="checkbox"
                      checked={layer2Border}
                      onChange={(e) => setLayer2Border(e.target.checked)}
                      className="w-4 h-4 rounded border-gray-300 dark:border-gray-600 text-purple-600"
                      disabled={!showLayer2}
                    />
                    Border
                  </label>

                  <div>
                    <label className="block text-xs text-gray-600 dark:text-gray-400 mb-2">Corner Radius</label>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-600 dark:text-gray-400">TL</span>
                        <CornerInput
                          layer="layer2"
                          corner="topLeft"
                          value={layer2Radius.topLeft || 0}
                          linked={layer2Linked.topLeft}
                          onChange={(value) => handleCornerChange('layer2', 'topLeft', value, layer2Linked, setLayer2Radius)}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-600 dark:text-gray-400">TR</span>
                        <CornerInput
                          layer="layer2"
                          corner="topRight"
                          value={layer2Radius.topRight || 0}
                          linked={layer2Linked.topRight}
                          onChange={(value) => handleCornerChange('layer2', 'topRight', value, layer2Linked, setLayer2Radius)}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-600 dark:text-gray-400">BL</span>
                        <CornerInput
                          layer="layer2"
                          corner="bottomLeft"
                          value={layer2Radius.bottomLeft || 0}
                          linked={layer2Linked.bottomLeft}
                          onChange={(value) => handleCornerChange('layer2', 'bottomLeft', value, layer2Linked, setLayer2Radius)}
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-gray-600 dark:text-gray-400">BR</span>
                        <CornerInput
                          layer="layer2"
                          corner="bottomRight"
                          value={layer2Radius.bottomRight || 0}
                          linked={layer2Linked.bottomRight}
                          onChange={(value) => handleCornerChange('layer2', 'bottomRight', value, layer2Linked, setLayer2Radius)}
                        />
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right Column - CSS Output */}
        <div className="relative rounded-xl backdrop-blur-md
          bg-gradient-to-b from-white/80 to-white/60 dark:from-white/10 dark:to-black/30
          border border-gray-200 dark:border-zinc-800/50
          shadow-[0_10px_30px_-15px_rgba(0,0,0,0.1)] dark:shadow-[0_10px_30px_-15px_rgba(0,0,0,0.7)]
          h-full">
          
          <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
            <h3 className="text-lg font-semibold text-gray-800 dark:text-white">CSS Styles</h3>
            <button
              onClick={handleCopyToClipboard}
              className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors flex items-center gap-2 shadow-lg shadow-purple-600/25"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied!' : 'Copy Styles'}
            </button>
          </div>
          
          <div className="p-6">
            <pre className="text-sm text-gray-300 overflow-x-auto bg-gray-900 dark:bg-black/50 p-4 rounded-lg border border-gray-800">
              <code>{generateCSS()}</code>
            </pre>
          </div>
        </div>
      </div>
    </motion.div>
  );
}; 