import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  createPool,
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { EnvironmentService } from "../config/environment.service";

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;

  constructor(@Inject(EnvironmentService) environment: EnvironmentService) {
    const config = environment.values.database;
    this.pool = createPool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      connectionLimit: config.connectionLimit,
      charset: "utf8mb4",
      timezone: "Z",
      decimalNumbers: false,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  async query<T extends RowDataPacket[]>(sql: string, parameters: unknown[] = []): Promise<T> {
    const [rows] = await this.pool.query<T>(sql, parameters);
    return rows;
  }

  async execute(sql: string, parameters: unknown[] = []): Promise<ResultSetHeader> {
    const [result] = await this.pool.execute<ResultSetHeader>(sql, parameters as never[]);
    return result;
  }

  async transaction<T>(operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
