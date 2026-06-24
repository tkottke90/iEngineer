export interface SessionResults {
  subsessionId: string;
  trackName: string;
  sessionType: string;
  startTime: string;
  results: Array<{
    carIdx: number;
    custId: number;
    displayName: string;
    finishPosition: number;
    lapsComplete: number;
    avgLapTime: number;
    bestLapTime: number;
  }>;
}

export interface LapData {
  lapNumber: number;
  lapTime: number;
  valid: boolean;
}

export interface DriverStats {
  custId: number;
  displayName: string;
  irating: number;
  safetyRating: string;
}

export class IRacingAPIClient {
  private cookies: string | null = null;

  async authenticate(email: string, password: string): Promise<void> {
    // TODO: implement iRacing login flow (hash password, POST to /auth)
    // Store cookie for subsequent requests
  }

  async getSessionResults(subsessionId: string): Promise<SessionResults> {
    // TODO: GET /data/results/lap_chart_data?subsession_id={id}
    throw new Error("Not implemented");
  }

  async getLapData(subsessionId: string, carIdx: number): Promise<LapData[]> {
    // TODO: GET /data/results/lap_data?subsession_id={id}&cust_id={id}
    throw new Error("Not implemented");
  }

  async getDriverStats(custId: number): Promise<DriverStats> {
    // TODO: GET /data/member/info?cust_id={id}
    throw new Error("Not implemented");
  }

  private async request<T>(path: string): Promise<T> {
    const url = `https://members-ng.iracing.com${path}`;
    const response = await fetch(url, {
      headers: { Cookie: this.cookies ?? "" },
    });
    if (!response.ok) throw new Error(`iRacing API error: ${response.status}`);
    const link = await response.json() as { link: string };
    const data = await fetch(link.link);
    return data.json() as Promise<T>;
  }
}
