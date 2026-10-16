/**
 * 高精度版 opencv-adapter.js
 * つかプロ：形を読み取ってロボットを動かす
 * 
 * 主な改良点:
 * 1. ガウシアンブラー + 大津の二値化 (Otsu Thresholding) による自動明暗補正
 * 2. モルフォロジー変換 (Opening/Closing) による影・ノイズの自動除去
 * 3. 面積フィルターによる背景ノイズの切り捨て
 * 4. 輪郭の外接矩形を用いた64x64中心正規化
 * 5. IoU（重なり度）+ Huモーメント（形状不変量）による複合判定
 */

class ShapeRecognizer {
    constructor() {
        this.TEMPLATE_SIZE = 64;
        this.MIN_CONTOUR_AREA = 500; // ノイズとして無視する最小面積
    }

    /**
     * 画像（HTMLImageElement または HTMLCanvasElement）から輪郭を抽出し、正規化データを生成
     * @param {HTMLImageElement|HTMLCanvasElement} imageElement 
     * @returns {Object|null} { normalizedMat, huMoments, area }
     */
    processImage(imageElement) {
        if (typeof cv === 'undefined' || !cv.Mat) {
            console.error("OpenCV.js が読み込まれていません。");
            return null;
        }

        let src = cv.imread(imageElement);
        let gray = new cv.Mat();
        let blurred = new cv.Mat();
        let binary = new cv.Mat();
        let morphed = new cv.Mat();

        try {
            // 1. グレースケール変換
            cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY, 0);

            // 2. ガウシアンブラーでちらつきやノイズを平滑化
            let ksize = new cv.Size(5, 5);
            cv.GaussianBlur(gray, blurred, ksize, 0, 0, cv.BORDER_DEFAULT);

            // 3. 大津の二値化（光の強さに応じて自動で最適な閾値を決定）
            // ※背景が暗くブロックが白い想定: THRESH_BINARY | THRESH_OTSU
            cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);

            // 4. モルフォロジー変換（影のチラつき除去＆ブロック内の穴埋め）
            let kernel = cv.Mat.ones(3, 3, cv.CV_8U);
            cv.morphologyEx(binary, morphed, cv.MORPH_OPEN, kernel);  // 点ノイズ除去
            cv.morphologyEx(morphed, morphed, cv.MORPH_CLOSE, kernel); // 輪郭の穴埋め
            kernel.delete();

            // 5. 輪郭抽出
            let contours = new cv.MatVector();
            let hierarchy = new cv.Mat();
            cv.findContours(morphed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

            // 最も面積の大きい輪郭（＝ブロック）を検出
            let maxArea = 0;
            let maxContourIdx = -1;
            for (let i = 0; i < contours.size(); ++i) {
                let cnt = contours.get(i);
                let area = cv.contourArea(cnt);
                if (area > maxArea && area >= this.MIN_CONTOUR_AREA) {
                    maxArea = area;
                    maxContourIdx = i;
                }
            }

            if (maxContourIdx === -1) {
                // ブロックが抽出できなかった場合
                src.delete(); gray.delete(); blurred.delete(); binary.delete(); morphed.delete();
                contours.delete(); hierarchy.delete();
                return null;
            }

            let bestContour = contours.get(maxContourIdx);

            // 6. 輪郭の外接矩形を切り出し、64x64へ中心正規化
            let rect = cv.boundingRect(bestContour);
            let roi = morphed.roi(rect);

            let normalizedMat = new cv.Mat();
            let dsize = new cv.Size(this.TEMPLATE_SIZE, this.TEMPLATE_SIZE);
            cv.resize(roi, normalizedMat, dsize, 0, 0, cv.INTER_AREA);

            // 7. Huモーメント（回転や拡大縮小に強い形状特徴量）の計算
            let moments = cv.moments(bestContour);
            let huMoments = new cv.Mat();
            cv.HuMoments(moments, huMoments);

            // メモリ解放
            roi.delete();
            src.delete(); gray.delete(); blurred.delete(); binary.delete(); morphed.delete();
            contours.delete(); hierarchy.delete();

            return {
                normalizedMat: normalizedMat,
                huMoments: huMoments,
                area: maxArea
            };

        } catch (e) {
            console.error("画像処理エラー:", e);
            src.delete(); gray.delete(); blurred.delete(); binary.delete(); morphed.delete();
            return null;
        }
    }

    /**
     * 2つの認識データ（撮影画像 vs 登録データ）の類似度スコア (0.0 〜 1.0) を算出
     * @param {Object} sampleFeature 
     * @param {Object} templateFeature 
     * @returns {number} 類似度スコア
     */
    calculateSimilarity(sampleFeature, templateFeature) {
        if (!sampleFeature || !templateFeature) return 0;

        let matA = sampleFeature.normalizedMat;
        let matB = templateFeature.normalizedMat;

        // A. IoU (Intersection over Union: ピクセルの論理積/論理和)
        let intersection = new cv.Mat();
        let unionMat = new cv.Mat();

        cv.bitwise_and(matA, matB, intersection);
        cv.bitwise_or(matA, matB, unionMat);

        let countInter = cv.countNonZero(intersection);
        let countUnion = cv.countNonZero(unionMat);

        let iouScore = countUnion > 0 ? (countInter / countUnion) : 0;

        intersection.delete();
        unionMat.delete();

        // B. Huモーメント（形状不変量）の比較
        let huDiff = 0;
        for (let i = 0; i < 7; i++) {
            let hA = sampleFeature.huMoments.doubleAt(i, 0);
            let hB = templateFeature.huMoments.doubleAt(i, 0);
            let mA = Math.sign(hA) * Math.log10(Math.abs(hA) + 1e-10);
            let mB = Math.sign(hB) * Math.log10(Math.abs(hB) + 1e-10);
            huDiff += Math.abs(mA - mB);
        }
        let huScore = Math.max(0, 1 - (huDiff / 8.0));

        // 複合スコア (IoU: 70% + Huモーメント: 30%)
        return (iouScore * 0.7) + (huScore * 0.3);
    }
}

// グローバル展開
window.ShapeRecognizer = ShapeRecognizer;