export interface Application {
    id: string;
    name?: string;
    key: string;
    limit?: string;
    timeout?: number;
    accept?: string[];
}
