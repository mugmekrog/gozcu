/* What the map is made of, as one list.
 *
 * The radar composes nine layers over one projection; until now each was either
 * always on or hidden behind its own control. This is the single registry the
 * layers menu renders and the radar reads, so adding a layer is one entry here
 * and one `layers.x &&` in Radar, not a new control.
 *
 * Order within a group is drawing order, bottom first -- the menu reads the way
 * the map is stacked.
 */

export type MapLayerId =
  | 'basemap'
  | 'labels'
  | 'area'
  | 'grid'
  | 'heat'
  | 'zones'
  | 'frames'
  | 'routes'
  | 'roadmatch'
  | 'vehicles';

export type MapLayers = Record<MapLayerId, boolean>;

export const DEFAULT_LAYERS: MapLayers = {
  basemap: true,
  labels: true,
  area: true,
  grid: true,
  // The density field stays off until asked for: it costs a pass over the whole
  // window and dims the fleet it is drawn under.
  heat: false,
  zones: true,
  frames: true,
  routes: true,
  roadmatch: true,
  vehicles: true,
};

export interface MapLayerSpec {
  id: MapLayerId;
  name: string;
  /**
   * What disappears when it is unticked, in two or three words. The name
   * carries the meaning; this is the confirmation under it, and a sentence
   * here makes a nine-row menu twice as tall for nothing.
   */
  description: string;
}

export interface MapLayerGroup {
  title: string;
  layers: MapLayerSpec[];
}

/** Altlık is the ground the day is drawn on; Veri is the day itself. */
export const LAYER_GROUPS: MapLayerGroup[] = [
  {
    title: 'ALTLIK',
    layers: [
      { id: 'basemap', name: 'Şehir haritası', description: 'Yollar ve yapılar' },
      { id: 'labels', name: 'Yer adları', description: 'Mahalle etiketleri' },
      { id: 'area', name: 'Operasyon alanı', description: 'Tatbikat sınırı' },
      { id: 'grid', name: 'Mesafe halkaları', description: 'Üsse uzaklık' },
    ],
  },
  {
    title: 'VERİ',
    layers: [
      { id: 'heat', name: 'Isı haritası', description: 'Araç yoğunluğu' },
      { id: 'zones', name: 'Bölgeler', description: 'Bölge ve tampon' },
      { id: 'frames', name: 'Görüntü kareleri', description: 'Drone kareleri' },
      { id: 'routes', name: 'Rota ve iz', description: 'Ham geçmiş yol' },
      { id: 'roadmatch', name: 'Yol eşlemesi', description: 'Yola oturtulmuş iz' },
      { id: 'vehicles', name: 'Araçlar', description: 'Canlı işaretler' },
    ],
  },
];
