// 判定エンジンの初期化
const recognizer = new ShapeRecognizer();

/**
 * 撮影されたカメラ画像から最も一致する命令（ブロック形状）を判定
 * @param {HTMLImageElement|HTMLCanvasElement} capturedImage 
 * @param {Array} registeredShapes [{ name: '前進', templates: [...] }, ...]
 * @returns {Object} { shapeName, score }
 */
function identifyBlock(capturedImage, registeredShapes) {
    // 撮影画像の解析
    const sampleFeature = recognizer.processImage(capturedImage);
    
    if (!sampleFeature) {
        return { shapeName: "未検出（ブロックを大きく写してください）", score: 0 };
    }

    let bestMatchName = "不明";
    let highestScore = 0;
    const CONFIDENCE_THRESHOLD = 0.50; // 確信度の閾値（0.50〜0.60推奨）

    // 登録されている全テンプレートと比較
    registeredShapes.forEach(shapeCategory => {
        shapeCategory.templates.forEach(templateFeature => {
            const score = recognizer.calculateSimilarity(sampleFeature, templateFeature);
            if (score > highestScore) {
                highestScore = score;
                bestMatchName = shapeCategory.name;
            }
        });
    });

    // 解析用メモリの解放（メモリリーク防止）
    if (sampleFeature.normalizedMat) sampleFeature.normalizedMat.delete();
    if (sampleFeature.huMoments) sampleFeature.huMoments.delete();

    if (highestScore >= CONFIDENCE_THRESHOLD) {
        return { shapeName: bestMatchName, score: highestScore };
    } else {
        return { shapeName: "認識不可（似たブロックがありません）", score: highestScore };
    }
}