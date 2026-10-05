const fs = require('fs');
const path = require('path');
const Jimp = require('jimp-compact');

const BG_COLOR = 0x080B10FF; // #080B10

async function main() {
  const sourcePath = path.resolve(__dirname, '../assets/mas_icon_square.png');
  if (!fs.existsSync(sourcePath)) {
    console.error('Source icon not found:', sourcePath);
    process.exit(1);
  }

  const baseIcon = await Jimp.read(sourcePath);
  console.log(`Loaded base icon: ${baseIcon.bitmap.width}x${baseIcon.bitmap.height}`);

  // 1. Android splash densities
  const splashTargets = [
    { dir: 'android/app/src/main/res/drawable-mdpi', size: 288, iconRatio: 0.65 },
    { dir: 'android/app/src/main/res/drawable-hdpi', size: 432, iconRatio: 0.65 },
    { dir: 'android/app/src/main/res/drawable-xhdpi', size: 576, iconRatio: 0.65 },
    { dir: 'android/app/src/main/res/drawable-xxhdpi', size: 864, iconRatio: 0.65 },
    { dir: 'android/app/src/main/res/drawable-xxxhdpi', size: 1152, iconRatio: 0.65 },
  ];

  for (const target of splashTargets) {
    const fullDir = path.resolve(__dirname, '..', target.dir);
    if (!fs.existsSync(fullDir)) {
      fs.mkdirSync(fullDir, { recursive: true });
    }

    const canvas = new Jimp(target.size, target.size, BG_COLOR);
    const iconDimension = Math.round(target.size * target.iconRatio);
    const resizedIcon = baseIcon.clone().resize(iconDimension, iconDimension);

    const x = Math.round((target.size - iconDimension) / 2);
    const y = Math.round((target.size - iconDimension) / 2);

    canvas.composite(resizedIcon, x, y);

    const outPath = path.join(fullDir, 'splashscreen_logo.png');
    await canvas.writeAsync(outPath);
    console.log(`Generated: ${target.dir}/splashscreen_logo.png (${target.size}x${target.size})`);
  }

  // 2. assets/splash-icon.png
  const splashIconPath = path.resolve(__dirname, '../assets/splash-icon.png');
  const splashCanvas = new Jimp(558, 558, BG_COLOR);
  const splashResized = baseIcon.clone().resize(420, 420);
  splashCanvas.composite(splashResized, Math.round((558 - 420) / 2), Math.round((558 - 420) / 2));
  await splashCanvas.writeAsync(splashIconPath);
  console.log(`Updated assets/splash-icon.png`);

  // 3. assets/android-icon-background.png (replace with pure dark #080B10 to remove ugly border)
  const bgPath = path.resolve(__dirname, '../assets/android-icon-background.png');
  const darkBgCanvas = new Jimp(512, 512, BG_COLOR);
  await darkBgCanvas.writeAsync(bgPath);
  console.log(`Updated assets/android-icon-background.png (dark background)`);

  // 4. assets/android-icon-foreground.png (clean centered icon)
  const fgPath = path.resolve(__dirname, '../assets/android-icon-foreground.png');
  const fgCanvas = new Jimp(512, 512, 0x00000000); // transparent background
  const fgIcon = baseIcon.clone().resize(380, 380);
  fgCanvas.composite(fgIcon, Math.round((512 - 380) / 2), Math.round((512 - 380) / 2));
  await fgCanvas.writeAsync(fgPath);
  console.log(`Updated assets/android-icon-foreground.png`);

  console.log('All splash and icon assets successfully updated!');
}

main().catch((err) => {
  console.error('Error generating assets:', err);
  process.exit(1);
});
