import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { Image } from 'expo-image';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { API_BASE_URL, MAX_FILE_MB, MAX_FILES } from '@/constants/config';

type SelectedAsset = ImagePicker.ImagePickerAsset & {
  rejectedReason?: string;
};

type ProcessedPage = {
  name: string;
  url: string;
  page: number;
};

type MenuItem = {
  name: string;
  price: string;
  description: string;
  image_url: string;
  page: number;
};

const toMb = (bytes?: number) => (typeof bytes === 'number' ? bytes / (1024 * 1024) : 0);

const formatBytes = (bytes?: number) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(1)} ${units[index]}`;
};

const getExtension = (mimeType?: string) => {
  if (!mimeType) return 'jpg';
  const [, subtype] = mimeType.split('/');
  if (subtype === 'jpeg') return 'jpg';
  return subtype ?? 'jpg';
};

const resolveAssetUrl = (pathOrUrl?: string) => {
  if (!pathOrUrl) return '';
  try {
    return new URL(pathOrUrl, API_BASE_URL).toString();
  } catch {
    return pathOrUrl;
  }
};

const currencySymbolMap: Record<string, string> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  CHF: 'CHF',
  CAD: 'CAD',
  AUD: 'AUD',
  INR: '₹',
  JPY: '¥',
};

const normalizeAmount = (amount: string | undefined) => {
  if (!amount) return null;
  let sanitized = amount.replace(/[^\d.,]/g, '');
  if (!sanitized) return null;
  const commaIndex = sanitized.indexOf(',');
  const dotIndex = sanitized.indexOf('.');
  if (commaIndex !== -1 && dotIndex !== -1) {
    if (dotIndex < commaIndex) {
      sanitized = sanitized.replace(/\./g, '').replace(',', '.');
    } else {
      sanitized = sanitized.replace(/,/g, '');
    }
  } else if (commaIndex !== -1) {
    sanitized = sanitized.replace(',', '.');
  }
  const parsed = Number.parseFloat(sanitized);
  if (!Number.isFinite(parsed)) return null;
  const hasFraction = !Number.isInteger(parsed);
  return parsed.toFixed(hasFraction ? 2 : 0);
};

const renderCurrency = (unit: string, amount: string) =>
  unit.length === 1 ? `${unit}${amount}` : `${unit} ${amount}`;

const PRICE_REGEX =
  /(?:(?<symbol>[€$£¥₹])\s*(?<amount>\d[\d.,]*))|(?:(?<amount2>\d[\d.,]*)\s*(?<symbol2>[€$£¥₹]))|(?:(?<code>(?:EUR|USD|GBP|CHF|CAD|AUD|INR|JPY))\s*(?<amount3>\d[\d.,]*))|(?:(?<amount4>\d[\d.,]*)\s*(?<code2>(?:EUR|USD|GBP|CHF|CAD|AUD|INR|JPY)))/gi;

const formatPrice = (raw?: string) => {
  if (!raw) return '€ --';
  const trimmed = raw.trim();
  if (!trimmed) return '—';
  if (trimmed.toUpperCase() === 'N/A') return 'N/A';

  let match: RegExpExecArray | null;
  type PriceCandidate = { unit: string; amount: string; priority: number };
  let best: PriceCandidate | null = null;

  const consider = (unit: string, amount: string, priority: number) => {
    if (!best || priority > best.priority) {
      best = { unit, amount, priority };
    }
  };

  while ((match = PRICE_REGEX.exec(trimmed))) {
    const groups = match.groups ?? {};
    const amount =
      groups.amount ?? groups.amount2 ?? groups.amount3 ?? groups.amount4 ?? '';
    const normalized = normalizeAmount(amount);
    if (!normalized) continue;

    const symbol = groups.symbol ?? groups.symbol2;
    if (symbol) {
      const priority = symbol === currencySymbolMap.EUR ? 2 : 3;
      consider(symbol, normalized, priority);
      continue;
    }

    const code = groups.code ?? groups.code2;
    if (code) {
      const unit = currencySymbolMap[code] ?? code;
      const priority = code === 'EUR' ? 2 : 4;
      consider(unit, normalized, priority);
    }
  }

  if (best) {
    return renderCurrency(best.unit, best.amount);
  }

  const fallback = trimmed.match(/\d[\d.,]*/);
  if (fallback) {
    const normalized = normalizeAmount(fallback[0]);
    if (normalized) {
      return normalized;
    }
  }

  return trimmed;
};

const ensureFileSize = async (asset: ImagePicker.ImagePickerAsset): Promise<SelectedAsset> => {
  if (typeof asset.fileSize === 'number' && asset.fileSize > 0) {
    return { ...asset };
  }

  try {
    const info = await FileSystem.getInfoAsync(asset.uri);
    if (info.exists && typeof info.size === 'number') {
      return { ...asset, fileSize: info.size };
    }
  } catch {
    // best-effort; ignore failures and fall back to provided metadata
  }

  return { ...asset };
};

const evaluateAssets = (assets: SelectedAsset[]) => {
  const accepted: SelectedAsset[] = [];
  let rejection = '';

  assets.forEach((asset, index) => {
    if (accepted.length >= MAX_FILES) {
      if (!rejection) {
        rejection = `Only the first ${MAX_FILES} files are kept.`;
      }
      return;
    }

    const sizeMb = toMb(asset.fileSize);
    if (sizeMb > MAX_FILE_MB) {
      if (!rejection) {
        const label = asset.fileName ?? `File ${index + 1}`;
        rejection = `${label} exceeds the ${MAX_FILE_MB} MB limit.`;
      }
      return;
    }

    accepted.push(asset);
  });

  return { accepted, rejection };
};

export default function HomeScreen() {
  const [selectedAssets, setSelectedAssets] = useState<SelectedAsset[]>([]);
  const [pages, setPages] = useState<ProcessedPage[]>([]);
  const [items, setItems] = useState<MenuItem[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const applyAssets = async (
    incoming: ImagePicker.ImagePickerAsset[],
    mode: 'replace' | 'append' = 'replace',
  ) => {
    const combined =
      mode === 'replace' ? incoming : [...selectedAssets, ...incoming];
    const normalized = await Promise.all(combined.map(ensureFileSize));
    const { accepted, rejection } = evaluateAssets(normalized);

    setSelectedAssets(accepted);
    setErrorMessage(rejection);
  };

  const handlePickImages = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== ImagePicker.PermissionStatus.GRANTED) {
      Alert.alert('Permission required', 'We need access to your photo library to continue.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: MAX_FILES,
      quality: 1,
    });

    if (result.canceled) {
      return;
    }

    await applyAssets(result.assets ?? [], 'replace');
  };

  const handleCaptureImage = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== ImagePicker.PermissionStatus.GRANTED) {
      Alert.alert('Permission required', 'Enable camera access to capture menu pages.');
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
      cameraType: ImagePicker.CameraType.back,
    });

    if (result.canceled) {
      return;
    }

    await applyAssets(result.assets ?? [], 'append');
  };

  const handleReset = () => {
    setSelectedAssets([]);
    setPages([]);
    setItems([]);
    setSessionId('');
    setErrorMessage('');
  };

  const handleUpload = async () => {
    if (!selectedAssets.length) {
      setErrorMessage('Add at least one menu image to continue.');
      return;
    }

    const formData = new FormData();

    selectedAssets.forEach((asset, index) => {
      const extension = getExtension(asset.mimeType);
      const name =
        asset.fileName ??
        `menu-page-${index + 1}.${extension.startsWith('.') ? extension.slice(1) : extension}`;
      formData.append('menu_images', {
        uri: asset.uri,
        name,
        type: asset.mimeType ?? 'image/jpeg',
      } as unknown as Blob);
    });

    try {
      setIsLoading(true);
      setErrorMessage('');
      setPages([]);
      setItems([]);
      setSessionId('');

      const response = await fetch(`${API_BASE_URL}/api/process`, {
        method: 'POST',
        body: formData,
        headers: {
          Accept: 'application/json',
        },
      });

      const payload = (await response.json().catch(() => ({}))) as {
        sessionId?: string;
        pages?: ProcessedPage[];
        items?: MenuItem[];
        error?: string;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? 'Menu processing failed. Try again.');
      }

      const resolvedPages = (payload.pages ?? []).map((page) => ({
        ...page,
        url: resolveAssetUrl(page.url),
      }));

      const resolvedItems = (payload.items ?? []).map((item) => ({
        ...item,
        image_url: resolveAssetUrl(item.image_url),
        price: formatPrice(item.price),
      }));

      setSessionId(payload.sessionId ?? '');
      setPages(resolvedPages);
      setItems(resolvedItems);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected error occurred.';
      setErrorMessage(message);
    } finally {
      setIsLoading(false);
    }
  };

  const totalBytes = selectedAssets.reduce((sum, asset) => sum + (asset.fileSize ?? 0), 0);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>SeeFood Mobile</Text>
          <Text style={styles.subtitle}>
            Digitise restaurant menus on the go and keep your team aligned.
          </Text>
        </View>
        {sessionId ? <Text style={styles.session}>Session {sessionId}</Text> : null}
      </View>

      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Menu photos</Text>
          <Pressable onPress={handleReset} disabled={isLoading}>
            <Text style={[styles.resetButton, isLoading && styles.resetButtonDisabled]}>Clear</Text>
          </Pressable>
        </View>
        <Text style={styles.cardHint}>
          Select or capture JPG, PNG, WebP, or HEIC. Max {MAX_FILES} files · {MAX_FILE_MB} MB each.
        </Text>

        <View style={styles.selectorCard}>
          <Text style={styles.selectorIcon}>📄</Text>
          <Text style={styles.selectorText}>Add menu images</Text>
          <Text style={styles.selectorHint}>Choose from your library or capture new pages.</Text>
          <View style={styles.actionRow}>
            <Pressable
              style={[styles.actionButton, isLoading && styles.actionButtonDisabled]}
              onPress={handlePickImages}
              disabled={isLoading}>
              <Text style={styles.actionLabel}>Browse library</Text>
            </Pressable>
            <Pressable
              style={[styles.actionButtonSecondary, isLoading && styles.actionButtonDisabled]}
              onPress={handleCaptureImage}
              disabled={isLoading}>
              <Text style={styles.actionLabelSecondary}>Capture photo</Text>
            </Pressable>
          </View>
        </View>

        {selectedAssets.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.previewStrip}>
            {selectedAssets.map((asset) => (
              <View style={styles.previewCard} key={asset.assetId ?? asset.uri}>
                <Image source={{ uri: asset.uri }} style={styles.previewImage} contentFit="cover" />
                <View style={styles.previewInfo}>
                  <Text style={styles.previewName} numberOfLines={1}>
                    {asset.fileName ?? 'Selected image'}
                  </Text>
                  <Text style={styles.previewSize}>{formatBytes(asset.fileSize)}</Text>
                </View>
              </View>
            ))}
          </ScrollView>
        ) : null}

        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}

        <Pressable
          style={[styles.primaryButton, isLoading && styles.primaryButtonDisabled]}
          onPress={handleUpload}
          disabled={isLoading}>
          {isLoading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.primaryLabel}>Generate menu cards</Text>
          )}
        </Pressable>

        <View style={styles.metaRow}>
          <Text style={styles.metaText}>{selectedAssets.length} files selected</Text>
          <Text style={styles.metaText}>{formatBytes(totalBytes)}</Text>
        </View>
      </View>

      {pages.length > 0 ? (
        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <Text style={styles.cardTitle}>Captured pages</Text>
          </View>
          <View style={styles.pageGrid}>
            {pages.map((page) => (
              <View style={styles.pageCard} key={`${page.page}-${page.url}`}>
                <Image source={{ uri: page.url }} style={styles.pageImage} contentFit="cover" />
                <Text style={styles.pageCaption}>{`Page ${page.page}`}</Text>
                <Text style={styles.pageName} numberOfLines={1}>
                  {page.name}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {items.length > 0 ? (
        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <Text style={styles.cardTitle}>Menu items</Text>
            <Text style={styles.sectionMeta}>{items.length} items</Text>
          </View>
          <View style={styles.itemGrid}>
            {items.map((item, index) => (
              <View style={styles.itemCard} key={`${item.name}-${index}`}>
                <Image source={{ uri: item.image_url }} style={styles.itemImage} contentFit="cover" />
                <View style={styles.itemBody}>
                  <View style={styles.itemHeading}>
                    <Text style={styles.itemTitle}>{item.name}</Text>
                    <Text style={styles.itemPrice}>{item.price}</Text>
                  </View>
                  <Text style={styles.itemDescription}>{item.description}</Text>
                  <Text style={styles.badge}>Page {item.page}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <Text style={styles.footer}>Built with Railway · Flask · Expo</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0b1221',
  },
  container: {
    gap: 24,
    paddingHorizontal: 20,
    paddingVertical: 24,
  },
  header: {
    gap: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#f8fafc',
  },
  subtitle: {
    fontSize: 16,
    color: 'rgba(226, 232, 240, 0.72)',
  },
  session: {
    marginTop: 8,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(148, 163, 184, 0.2)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    color: '#e2e8f0',
    fontSize: 12,
    fontWeight: '600',
  },
  card: {
    backgroundColor: 'rgba(248, 250, 252, 0.96)',
    borderRadius: 24,
    padding: 18,
    gap: 16,
    shadowColor: '#0b1221',
    shadowOpacity: 0.2,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
    elevation: 6,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0f172a',
  },
  cardHint: {
    fontSize: 14,
    color: '#475569',
  },
  resetButton: {
    color: '#2563eb',
    fontWeight: '600',
  },
  resetButtonDisabled: {
    opacity: 0.5,
  },
  selectorCard: {
    backgroundColor: 'rgba(248, 250, 255, 0.92)',
    borderRadius: 20,
    borderWidth: 2,
    borderColor: 'rgba(37, 99, 235, 0.25)',
    paddingVertical: 24,
    paddingHorizontal: 18,
    alignItems: 'center',
    gap: 12,
  },
  selectorIcon: {
    fontSize: 32,
  },
  selectorText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1f2937',
  },
  selectorHint: {
    fontSize: 13,
    color: '#64748b',
    textAlign: 'center',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
  },
  actionButton: {
    flex: 1,
    backgroundColor: '#2563eb',
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
  },
  actionButtonSecondary: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(37, 99, 235, 0.4)',
    backgroundColor: '#e0f2fe',
  },
  actionButtonDisabled: {
    opacity: 0.6,
  },
  actionLabel: {
    color: '#fff',
    fontWeight: '600',
  },
  actionLabelSecondary: {
    color: '#1d4ed8',
    fontWeight: '600',
  },
  previewStrip: {
    flexGrow: 0,
  },
  previewCard: {
    width: 140,
    marginRight: 12,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#fff',
  },
  previewImage: {
    width: '100%',
    height: 110,
  },
  previewInfo: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 4,
  },
  previewName: {
    fontSize: 12,
    fontWeight: '600',
    color: '#1f2937',
  },
  previewSize: {
    fontSize: 11,
    color: '#64748b',
  },
  error: {
    backgroundColor: '#fee2e2',
    color: '#b91c1c',
    borderRadius: 12,
    padding: 12,
    fontWeight: '600',
  },
  primaryButton: {
    backgroundColor: '#2563eb',
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButtonDisabled: {
    opacity: 0.7,
  },
  primaryLabel: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  metaText: {
    fontSize: 12,
    color: '#475569',
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  sectionMeta: {
    fontSize: 14,
    color: '#64748b',
  },
  pageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  pageCard: {
    width: '48%',
    backgroundColor: '#f1f5f9',
    borderRadius: 16,
    padding: 10,
    gap: 8,
  },
  pageImage: {
    width: '100%',
    height: 160,
    borderRadius: 12,
  },
  pageCaption: {
    fontSize: 12,
    fontWeight: '700',
    color: '#111827',
  },
  pageName: {
    fontSize: 12,
    color: '#475569',
  },
  itemGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
  },
  itemCard: {
    width: '100%',
    borderRadius: 20,
    backgroundColor: '#ffffff',
    overflow: 'hidden',
    elevation: 4,
    shadowColor: '#0f172a',
    shadowOpacity: 0.15,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
  },
  itemImage: {
    width: '100%',
    height: 200,
  },
  itemBody: {
    padding: 16,
    gap: 8,
  },
  itemHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  itemTitle: {
    fontSize: 16,
    fontWeight: '700',
    flex: 1,
    color: '#0f172a',
  },
  itemPrice: {
    color: '#2563eb',
    fontWeight: '700',
    fontSize: 15,
  },
  itemDescription: {
    color: '#475569',
    fontSize: 14,
  },
  badge: {
    alignSelf: 'flex-start',
    fontSize: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#e0f2fe',
    color: '#0369a1',
    fontWeight: '600',
  },
  footer: {
    textAlign: 'center',
    color: 'rgba(226, 232, 240, 0.7)',
    marginBottom: 40,
  },
});
